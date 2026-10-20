import {
	type ChildProcess,
	type ExecFileException,
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import { homedir } from "node:os";
import {
	APPEARANCE_LIMITS,
	AppearanceError,
	buildInstalledFontCatalog,
	type InstalledFontCatalog,
} from "@hipi/work-runtime/appearance";
import { FONTCONFIG_FORMAT, MAC_FONT_SCRIPT, WINDOWS_FONT_SCRIPT } from "./font-scripts.ts";
import { openTypeFontNames } from "./opentype-font-names.ts";

export const NATIVE_FONT_LIMITS = { timeoutMs: 10000, outputBytes: 4 * 1024 * 1024 } as const;
const scriptStages = ["assembly", "enumeration", "glyph", "local-uri", "font-stream", "serialization"] as const;
type ScriptStage = (typeof scriptStages)[number];
export type FontDiagnostic =
	| {
			phase: "process";
			outcome: "success" | "cancelled" | "missing" | "denied" | "output-limit" | "timeout" | "nonzero" | "failed";
			exit: number | null;
			elapsedMs: number;
			killed: boolean;
			cancelled: boolean;
	  }
	| { phase: "parser"; outcome: "output-limit" | "json" | "envelope" }
	| { phase: "script"; outcome: "DENIED" | "FAILED"; stage: ScriptStage | "unknown" };
type FontDiagnosticSink = (diagnostic: FontDiagnostic) => void;
const logFontDiagnostic: FontDiagnosticSink = (diagnostic) => {
	console.warn(JSON.stringify({ event: "native-fonts", ...diagnostic }));
};
function reportFontDiagnostic(sink: FontDiagnosticSink, diagnostic: FontDiagnostic): void {
	try {
		sink(diagnostic);
	} catch {
		// Diagnostics cannot change request outcomes or subprocess admission.
	}
}
export type FontCommand = { file: string; args: readonly string[]; env: Record<string, string>; cwd: string };
export type FontHostEnvironment = { systemRoot?: string; windir?: string };
/** Fixed executable allowlist. No PATH search, inherited loader variables, user scripts, or shell. */
export function fontCommand(
	platform: string,
	home: string,
	host: FontHostEnvironment = {
		systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
		windir: process.env.WINDIR ?? process.env.windir,
	},
): FontCommand {
	if (platform === "linux")
		return {
			file: "/usr/bin/fc-list",
			args: ["-f", FONTCONFIG_FORMAT],
			env: { HOME: home, LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
			cwd: "/",
		};
	if (platform === "darwin")
		return {
			file: "/usr/bin/osascript",
			args: ["-l", "JavaScript", "-e", MAC_FONT_SCRIPT],
			env: { HOME: home, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
			cwd: "/",
		};
	if (platform === "win32") {
		if (
			!host.systemRoot ||
			!host.windir ||
			!/^c:\\windows\\?$/i.test(host.systemRoot) ||
			!/^c:\\windows\\?$/i.test(host.windir)
		)
			throw new AppearanceError("UNSUPPORTED");
		return {
			// Standard Windows installations only. Observed roots may only confirm, never choose code.
			file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_FONT_SCRIPT],
			env: {
				SystemRoot: "C:\\Windows",
				WINDIR: "C:\\Windows",
				USERPROFILE: home,
				PATH: "C:\\Windows\\System32",
				PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
			},
			cwd: "C:\\Windows",
		};
	}
	throw new AppearanceError("UNSUPPORTED");
}
export type FontProcess = { result: Promise<string>; cancel(): void };
export type FontRunner = (command: FontCommand) => FontProcess;
export type FontExecute = (
	file: string,
	args: string[],
	options: ExecFileOptionsWithStringEncoding,
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => Pick<ChildProcess, "kill">;
export function runFontProcess(
	command: FontCommand,
	execute: FontExecute = execFile,
	diagnostic: FontDiagnosticSink = logFontDiagnostic,
): FontProcess {
	let child: Pick<ChildProcess, "kill"> | undefined;
	let cancelled = false;
	const started = performance.now();
	const result = new Promise<string>((resolve, reject) => {
		child = execute(
			command.file,
			[...command.args],
			{
				encoding: "utf8",
				env: command.env,
				cwd: command.cwd,
				shell: false,
				timeout: NATIVE_FONT_LIMITS.timeoutMs,
				maxBuffer: NATIVE_FONT_LIMITS.outputBytes,
				windowsHide: true,
				killSignal: "SIGKILL",
			},
			(error, stdout) => {
				reportFontDiagnostic(diagnostic, {
					phase: "process",
					outcome: cancelled
						? "cancelled"
						: !error
							? "success"
							: error.code === "ENOENT" || error.code === "ENOTDIR"
								? "missing"
								: error.code === "EACCES" || error.code === "EPERM"
									? "denied"
									: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
										? "output-limit"
										: error.code === "ETIMEDOUT"
											? "timeout"
											: typeof error.code === "number" && error.code !== 0
												? "nonzero"
												: "failed",
					exit: typeof error?.code === "number" && Number.isSafeInteger(error.code) ? error.code : null,
					elapsedMs: Math.min(86400000, Math.max(0, Math.round(performance.now() - started))),
					killed: error?.killed === true,
					cancelled,
				});
				if (cancelled) reject(new AppearanceError("CLOSED"));
				else if (error)
					reject(
						new AppearanceError(
							error.code === "ENOENT" || error.code === "ENOTDIR"
								? "UNSUPPORTED"
								: error.code === "EACCES" || error.code === "EPERM"
									? "DENIED"
									: "FAILED",
						),
					);
				else resolve(stdout);
			},
		);
	});
	return {
		result,
		cancel: () => {
			if (cancelled) return;
			cancelled = true;
			try {
				child?.kill("SIGKILL");
			} catch {
				/* Exit callback still owns final admission cleanup. */
			}
		},
	};
}
export function parseNativeFonts(
	platform: string,
	output: string,
	diagnostic: FontDiagnosticSink = logFontDiagnostic,
): InstalledFontCatalog {
	const fail = (outcome: "output-limit" | "json" | "envelope"): never => {
		reportFontDiagnostic(diagnostic, { phase: "parser", outcome });
		throw new AppearanceError("FAILED");
	};
	if (Buffer.byteLength(output, "utf8") > NATIVE_FONT_LIMITS.outputBytes) fail("output-limit");
	if (platform === "linux") {
		const lines = output.split("\x1e");
		if (lines.at(-1) === "") lines.pop();
		return buildInstalledFontCatalog(
			lines.slice(0, APPEARANCE_LIMITS.faces).map((line) => {
				const [family, fullName, postscriptName, style, spacing, ...extra] = line.split("\x1f");
				// Fontconfig's actual spacing constants: proportional=0, dual=90, mono=100, charcell=110.
				return {
					face: extra.length ? null : { family, fullName, postscriptName, style },
					monospace: spacing === "100" || spacing === "110" ? true : spacing === "0" || spacing === "90" ? false : null,
				};
			}),
			lines.length > APPEARANCE_LIMITS.faces,
		);
	}
	if (platform !== "darwin" && platform !== "win32") throw new AppearanceError("UNSUPPORTED");
	let raw: unknown;
	try {
		raw = JSON.parse(output);
	} catch {
		fail("json");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("envelope");
	const value = raw as Record<string, unknown>;
	if (value.error === "DENIED" || value.error === "FAILED") {
		const stage = scriptStages.find((stage) => stage === value.stage);
		if (
			!(
				(Object.keys(value).length === 1 && value.stage === undefined) ||
				(platform === "win32" && Object.keys(value).length === 2 && stage)
			)
		)
			fail("envelope");
		reportFontDiagnostic(diagnostic, { phase: "script", outcome: value.error, stage: stage ?? "unknown" });
		throw new AppearanceError(value.error);
	}
	const field = platform === "darwin" ? "rows" : "tables";
	if (Object.keys(value).length !== 2 || typeof value.truncated !== "boolean" || !Array.isArray(value[field]))
		return fail("envelope");
	let partial = value.truncated;
	const rows = value[field] as unknown[];
	const entries = rows.slice(0, APPEARANCE_LIMITS.faces).map((candidate) => {
		try {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new AppearanceError("INVALID");
			const row = candidate as Record<string, unknown>;
			if (Object.keys(row).length !== 2 || (row.monospace !== null && typeof row.monospace !== "boolean"))
				throw new AppearanceError("INVALID");
			return {
				face: platform === "win32" ? openTypeFontNames(row.name) : row.face,
				monospace: row.monospace as boolean | null,
			};
		} catch {
			partial = true;
			return { face: null, monospace: null };
		}
	});
	return buildInstalledFontCatalog(entries, partial || rows.length > APPEARANCE_LIMITS.faces);
}
/** One child per owner. Abort ends the caller's wait but admission stays occupied until child exit. */
export class NativeFontService {
	readonly #platform: string;
	readonly #runner: FontRunner;
	readonly #host: FontHostEnvironment | undefined;
	#pending: FontProcess | undefined;
	constructor(platform: string, runner: FontRunner = runFontProcess, host?: FontHostEnvironment) {
		this.#platform = platform;
		this.#runner = runner;
		this.#host = host;
	}
	async list(signal: AbortSignal): Promise<InstalledFontCatalog> {
		if (signal.aborted) throw new AppearanceError("CLOSED");
		if (this.#pending) throw new AppearanceError("BUSY");
		const operation = this.#runner(fontCommand(this.#platform, homedir(), this.#host));
		this.#pending = operation;
		const cancel = () => operation.cancel();
		signal.addEventListener("abort", cancel, { once: true });
		try {
			const output = await operation.result;
			if (signal.aborted) throw new AppearanceError("CLOSED");
			return parseNativeFonts(this.#platform, output);
		} finally {
			signal.removeEventListener("abort", cancel);
			if (this.#pending === operation) this.#pending = undefined;
		}
	}
}
