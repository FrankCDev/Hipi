import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEVELOPMENT_QUIT, DEVELOPMENT_READY } from "../../src/development/launch.ts";

/** Never reuse bundles that may still belong to a desktop surviving its original CLI. */
export async function createDevelopmentOutput(repository) {
	const parent = join(repository, ".artifacts", "desktop-development");
	await mkdir(parent, { recursive: true });
	return mkdtemp(join(parent, "run-"));
}

/** Own a single child. Never signal a process selected by name, profile, port, or recycled PID. */
export function startDesktop(binary, args, { cwd, env, onOutput = () => {}, readyTimeout = 60000 } = {}) {
	const child = spawn(binary, args, {
		cwd,
		env,
		shell: false,
		detached: true,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let exited = false;
	let isReady = false;
	let quitRequested = false;
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	// A failure can happen before the caller reaches its await.
	void ready.catch(() => {});
	const timer = setTimeout(
		() => readyReject(new Error("Desktop startup did not report readiness within 60 seconds")),
		readyTimeout,
	);
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		if (line === DEVELOPMENT_READY) {
			isReady = true;
			clearTimeout(timer);
			readyResolve();
		} else onOutput(`${line}\n`);
	});
	child.stderr.on("data", (data) => onOutput(data.toString()));
	child.stdin.on("error", () => {});
	const completion = new Promise((resolve) => {
		child.once("error", (error) =>
			readyReject(new Error(`Desktop process could not start (${error.code ?? "unknown"})`)),
		);
		child.once("exit", () => {
			exited = true;
		});
		child.once("close", (code, signal) => {
			exited = true;
			clearTimeout(timer);
			lines.close();
			readyReject(new Error(`Desktop exited before readiness (code ${code ?? signal})`));
			resolve({ code, signal, requested: quitRequested });
		});
	});
	return {
		ready,
		completion,
		get exited() {
			return exited;
		},
		get isReady() {
			return isReady;
		},
		quit(retry = false) {
			const send = !quitRequested || retry;
			quitRequested = true;
			if (send && !exited && child.stdin.writable) child.stdin.write(`${DEVELOPMENT_QUIT}\n`);
			return completion;
		},
	};
}

/** Coalesce rebuilds, but never publish files or reuse a profile until its previous owner exited. */
export function restartCoordinator({ stop, publish, start, failed }) {
	let requested = 0;
	let completed = 0;
	let closing = false;
	let running;
	let broken = false;
	const schedule = () => {
		if (closing || broken || running || completed >= requested) return;
		running = drain()
			.catch((error) => {
				broken = true;
				failed(error);
			})
			.finally(() => {
				running = undefined;
				schedule();
			});
	};
	const drain = async () => {
		while (!closing && completed < requested) {
			await stop();
			if (closing) return;
			const revision = requested;
			if (!(await publish())) {
				completed = revision;
				continue;
			}
			if (closing) return;
			await start();
			completed = revision;
		}
	};
	return {
		request() {
			if (closing) return;
			requested++;
			schedule();
		},
		async close() {
			closing = true;
			await stop();
			await running;
		},
	};
}
