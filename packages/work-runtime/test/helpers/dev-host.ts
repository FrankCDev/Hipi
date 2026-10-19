import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

function deadline<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), milliseconds);
		void pending.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Real CLI process and real inherited IPC; forced termination is cleanup, never a clean result. */
export async function startDevHost(input: {
	directory: string;
	provider: "deterministic" | "openai";
	origin: string;
	env?: NodeJS.ProcessEnv;
	preload?: URL;
}) {
	const child = spawn(
		process.execPath,
		[
			...(input.preload ? ["--import", input.preload.href] : []),
			"--conditions=source",
			fileURLToPath(new URL("../../src/dev-server.ts", import.meta.url)),
			"--provider",
			input.provider,
			"--origin",
			input.origin,
			"--data",
			input.directory,
		],
		{ stdio: ["ignore", "pipe", "pipe", "ipc"], env: input.env ?? process.env },
	);
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const ready = Promise.withResolvers<{ url: string; token: string }>();
	let output = "",
		logs = "";
	assert.ok(child.stdout);
	assert.ok(child.stderr);
	child.stdout.on("data", (chunk: Buffer) => {
		output = (output + chunk.toString("utf8")).slice(-65536);
		const match = /API: (http:\/\/127\.0\.0\.1:\d+)\nToken: ([a-f0-9]+)\n/.exec(output);
		if (match) ready.resolve({ url: match[1], token: match[2] });
	});
	child.stderr.on("data", (chunk: Buffer) => {
		logs = (logs + chunk.toString("utf8")).slice(-65536);
	});
	child.once("error", () => ready.reject(new Error("Acceptance host failed to start")));
	void exited.then(({ code, signal }) =>
		ready.reject(new Error(`Acceptance host exited before readiness (${code ?? signal})`)),
	);
	async function forceCleanup() {
		if (child.pid === undefined) return;
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await deadline(exited, 5000, "Acceptance host did not exit after forced cleanup");
	}
	let connection: { url: string; token: string };
	try {
		connection = await deadline(ready.promise, 5000, "Acceptance host did not become ready");
	} catch (error) {
		await forceCleanup();
		throw error;
	}
	let closing: Promise<void> | undefined;
	return {
		child,
		connection,
		output,
		logs: () => logs,
		close(): Promise<void> {
			closing ??= (async () => {
				try {
					if (child.connected)
						await new Promise<void>((resolve, reject) =>
							child.send({ type: "hipi.dev-host.shutdown" }, (error) => {
								// The peer can close its pipe before this process observes disconnect/exit.
								// Only the exit and port checks below can establish successful shutdown.
								if (
									error &&
									(!("code" in error) || (error.code !== "ERR_IPC_CHANNEL_CLOSED" && error.code !== "EPIPE"))
								)
									reject(error);
								else resolve();
							}),
						);
					const result = await deadline(exited, 5000, "Acceptance host did not shut down gracefully");
					assert.equal(result.signal, null, "Graceful shutdown must not require a termination signal");
					assert.equal(result.code, 0, "Graceful shutdown must complete every owned resource close");
					await new Promise<void>((resolve, reject) => {
						const address = new URL(connection.url);
						const socket = createConnection({ host: address.hostname, port: Number(address.port) });
						socket.setTimeout(1000, () =>
							socket.destroy(new Error("Acceptance host port closure check timed out")),
						);
						socket.once("connect", () => {
							socket.destroy();
							reject(new Error("Acceptance host port remained open after exit"));
						});
						socket.once("error", (error: NodeJS.ErrnoException) => {
							if (error.code === "ECONNREFUSED") resolve();
							else reject(error);
						});
					});
				} catch (error) {
					await forceCleanup();
					throw error;
				}
			})();
			return closing;
		},
	};
}
