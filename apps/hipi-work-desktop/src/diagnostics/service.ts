import { writeFile } from "node:fs/promises";
import { RUNTIME_DIAGNOSTICS, type RuntimeDiagnostic } from "./runtime.ts";

export const DIAGNOSTIC_LIMITS = { bytes: 4096, count: 9999, writeWaitMs: 10000 } as const;
const codes = [
	"RUNTIME_UNAVAILABLE",
	"HOST_STARTUP_FAILED",
	"SHUTDOWN_TIMEOUT",
	"RENDERER_GONE",
	"EXPORT_FAILED",
	"EXPORT_WRITE_UNKNOWN",
] as const;
export type DiagnosticCode = (typeof codes)[number];
const states = ["idle", "starting", "ready", "failed", "stopping", "exited"] as const;
export type DiagnosticRuntimeState = (typeof states)[number];
type Metadata = {
	productVersion: string;
	electronVersion: string;
	nodeVersion: string;
	platform: string;
	arch: string;
};

function version(value: unknown): string {
	return typeof value === "string" &&
		value.length <= 32 &&
		/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/.exec(value)?.[0] === value
		? value
		: "unknown";
}

/** Session-local counters only. Unknown codes and extra fields never enter retained state. */
export class DesktopDiagnostics {
	readonly #counts = new Map<DiagnosticCode, number>();
	readonly #runtimeCounts = new Map<RuntimeDiagnostic, number>();
	recordRuntime(diagnostic: RuntimeDiagnostic): void {
		const allowed = RUNTIME_DIAGNOSTICS.find(
			(item) => item.category === diagnostic.category && item.phase === diagnostic.phase,
		);
		if (allowed)
			this.#runtimeCounts.set(allowed, Math.min(DIAGNOSTIC_LIMITS.count, (this.#runtimeCounts.get(allowed) ?? 0) + 1));
	}
	record(code: unknown): void {
		for (const allowed of codes) {
			if (code === allowed) {
				this.#counts.set(allowed, Math.min(DIAGNOSTIC_LIMITS.count, (this.#counts.get(allowed) ?? 0) + 1));
				return;
			}
		}
	}
	serialize(metadata: Metadata, runtimeState: unknown): string {
		// Construct from scalars; never spread input, serialize exceptions, or inspect logs.
		const content = `${JSON.stringify(
			{
				schemaVersion: 2,
				product: "Hipi Work",
				productVersion: version(metadata.productVersion),
				electronVersion: version(metadata.electronVersion),
				nodeVersion: version(metadata.nodeVersion),
				platform: ["win32", "darwin", "linux"].includes(metadata.platform) ? metadata.platform : "unknown",
				arch: ["x64", "arm64", "ia32", "arm"].includes(metadata.arch) ? metadata.arch : "unknown",
				runtimeState: states.find((state) => state === runtimeState) ?? "unknown",
				counterScope: "current-desktop-process",
				counterLimit: DIAGNOSTIC_LIMITS.count,
				events: codes.map((code) => ({ code, count: this.#counts.get(code) ?? 0 })),
				runtimeEvents: RUNTIME_DIAGNOSTICS.map((item) => ({
					category: item.category,
					phase: item.phase,
					count: this.#runtimeCounts.get(item) ?? 0,
				})),
			},
			null,
			2,
		)}\n`;
		if (Buffer.byteLength(content, "utf8") > DIAGNOSTIC_LIMITS.bytes) throw new Error("DIAGNOSTIC_SIZE_LIMIT");
		return content;
	}
}

export type ExportOutcome = "saved" | "cancelled" | "busy" | "closed" | "failed" | "write-unknown";
/** Startup recovery has no renderer. Review failure or cancellation cannot end a live writer. */
export async function finishFailedStartup(ports: {
	stop(): Promise<boolean>;
	review(): Promise<void>;
	exit(): void;
}): Promise<void> {
	const stopped = Promise.resolve()
		.then(ports.stop)
		.then(
			() => true,
			() => false,
		);
	try {
		await ports.review();
	} catch {
		/* Native dialog failure must still wait for observed runtime exit. */
	}
	if (!(await stopped)) throw new Error("RUNTIME_EXIT_UNCONFIRMED");
	ports.exit();
}
type ExportPorts = {
	snapshot(): string;
	preview(content: string): Promise<boolean>;
	pick(): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
};

/** Exclusive creation avoids overwriting or following an existing symlink. No automatic retry. */
export async function writeDiagnosticFile(path: string, content: string): Promise<void> {
	if (Buffer.byteLength(content, "utf8") > DIAGNOSTIC_LIMITS.bytes) throw new Error("DIAGNOSTIC_SIZE_LIMIT");
	await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/** The host owns lifetime. An unresolved write retains admission even if its outcome is unknown. */
export class DiagnosticExporter {
	#busy = false;
	#closed = false;
	close(): void {
		this.#closed = true;
	}
	async export(ports: ExportPorts): Promise<ExportOutcome> {
		if (this.#closed) return "closed";
		if (this.#busy) return "busy";
		this.#busy = true;
		let writing = false;
		let releaseAdmission = true;
		try {
			const content = ports.snapshot();
			if (Buffer.byteLength(content, "utf8") > DIAGNOSTIC_LIMITS.bytes) return "failed";
			if (!(await ports.preview(content))) return "cancelled";
			if (this.#closed) return "closed";
			const path = await ports.pick();
			if (this.#closed) return "closed";
			if (path === null) return "cancelled";
			writing = true;
			const write = ports.write(path, content);
			releaseAdmission = false;
			const settled = write.then(
				() => {
					this.#busy = false;
					return "saved" as const;
				},
				() => {
					this.#busy = false;
					return "write-unknown" as const;
				},
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					settled,
					new Promise<"write-unknown">((resolve) => {
						timer = setTimeout(() => resolve("write-unknown"), DIAGNOSTIC_LIMITS.writeWaitMs);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} catch {
			return writing ? "write-unknown" : "failed";
		} finally {
			if (releaseAdmission) this.#busy = false;
		}
	}
}
