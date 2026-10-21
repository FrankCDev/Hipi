import { randomUUID } from "node:crypto";
import { AppError } from "@hipi/work-runtime/contracts";
import { credentialReply, type RuntimeCredentials } from "../credentials/rpc.ts";
import { type RuntimeDiagnostic, runtimeDiagnostic } from "../diagnostics/runtime.ts";
import type { DiagnosticRuntimeState } from "../diagnostics/service.ts";
import { decode, encode, exact, WAIT_MS } from "../ipc/protocol.ts";
import { HostConnection } from "./connection.ts";

type Child = {
	postMessage(raw: string): void;
	kill(): boolean;
	on(event: "message", listener: (raw: unknown) => void): unknown;
	once(event: "exit", listener: (code: number) => void): unknown;
};
type Incarnation = {
	child: Child;
	host: HostConnection;
	generation: string;
	state: "starting" | "ready" | "failed" | "stopping" | "exited";
	stopped: boolean;
	failStartup(error: Error): void;
	startupTimer: ReturnType<typeof setTimeout>;
	shutdownTimer?: ReturnType<typeof setTimeout>;
};
/** Restart only after observed process exit, with a finite lifetime budget. No application request is retained. */
export class RuntimeSupervisor {
	readonly #fork: (generation: string) => Child;
	readonly #report: (event: "unavailable" | "shutdown-timeout") => void;
	readonly #credentials?: RuntimeCredentials;
	readonly #diagnostic: (diagnostic: RuntimeDiagnostic) => void;
	#current?: Incarnation;
	#restarts = 0;
	#closing = false;
	#closed?: Promise<boolean>;
	#finish?: (clean: boolean) => void;
	constructor(
		fork: (generation: string) => Child,
		report: (event: "unavailable" | "shutdown-timeout") => void,
		credentials?: RuntimeCredentials,
		diagnostic: (diagnostic: RuntimeDiagnostic) => void = () => {},
	) {
		this.#fork = fork;
		this.#report = report;
		this.#credentials = credentials;
		this.#diagnostic = diagnostic;
	}
	start() {
		if (this.#current || this.#closing) throw new AppError("CLOSED");
		return new Promise<void>((resolve, reject) => this.#spawn(resolve, reject));
	}
	#spawn(onReady: () => void = () => {}, onFailure: (error: Error) => void = () => {}) {
		const generation = randomUUID();
		const child = this.#fork(generation);
		const host = new HostConnection(
			generation,
			(raw) => child.postMessage(raw),
			() => {
				current.state = "failed";
				child.kill();
				this.#report("unavailable");
			},
		);
		const current: Incarnation = {
			child,
			host,
			generation,
			state: "starting",
			stopped: false,
			failStartup: onFailure,
			startupTimer: setTimeout(() => {
				host.close();
				current.state = "failed";
				child.kill();
				onFailure(new AppError("CLOSED"));
				this.#report("unavailable");
			}, WAIT_MS),
		};
		this.#current = current;
		let credentialCalls = 0;
		child.on("message", (raw: unknown) => {
			if (this.#current !== current || current.state === "exited") return;
			try {
				const message = decode(raw);
				if (message.generation !== generation) return;
				if (message.kind === "diagnostic") {
					const diagnostic = runtimeDiagnostic(message);
					if (["starting", "ready", "stopping"].includes(current.state)) this.#diagnostic(diagnostic);
				} else if (message.kind === "credentialRequest") {
					if (
						!this.#credentials ||
						this.#closing ||
						!["starting", "ready"].includes(current.state) ||
						credentialCalls >= 16
					)
						throw new AppError("CLOSED");
					credentialCalls++;
					void credentialReply(raw, generation, this.#credentials)
						.then((reply) => {
							if (this.#current === current && !this.#closing && ["starting", "ready"].includes(current.state))
								child.postMessage(reply);
						})
						.catch(() => {
							if (this.#current !== current || current.state === "exited") return;
							current.state = "failed";
							host.close();
							child.kill();
							this.#report("unavailable");
						})
						.finally(() => {
							credentialCalls--;
						});
				} else if (message.kind === "ready") {
					exact(message, ["generation", "kind"]);
					if (!this.#closing && current.state === "starting") {
						clearTimeout(current.startupTimer);
						current.state = "ready";
						onReady();
					}
				} else if (message.kind === "stopped") {
					exact(message, ["generation", "kind"]);
					current.stopped = this.#closing;
					child.kill();
				} else if (message.kind === "fatal" || message.kind === "shutdownFailed") {
					exact(message, ["generation", "kind"]);
					current.state = "failed";
					host.close();
					onFailure(new AppError("CLOSED"));
					this.#report("unavailable");
					// A failed close may still own writers. Only an actual exit permits replacement.
				} else host.receive(raw);
			} catch {
				current.state = "failed";
				host.close();
				child.kill();
				onFailure(new AppError("CLOSED"));
				this.#report("unavailable");
			}
		});
		child.once("exit", () => {
			onFailure(new AppError("CLOSED"));
			current.state = "exited";
			clearTimeout(current.startupTimer);
			if (current.shutdownTimer) clearTimeout(current.shutdownTimer);
			host.close();
			if (this.#closing) {
				this.#finish?.(current.stopped);
				return;
			}
			if (this.#current !== current) return;
			if (this.#restarts++ < 2) {
				try {
					this.#spawn();
				} catch {
					this.#report("unavailable");
				}
			} else this.#report("unavailable");
		});
	}
	/** Read-only host state; never starts, reconnects or resumes runtime work. */
	diagnosticState(): DiagnosticRuntimeState {
		return this.#current?.state ?? "idle";
	}
	connection(): HostConnection {
		if (this.#closing || this.#current?.state !== "ready") throw new AppError("CLOSED");
		return this.#current.host;
	}
	close(): Promise<boolean> {
		if (this.#closed) return this.#closed;
		this.#closing = true;
		const current = this.#current;
		if (!current || current.state === "exited") return Promise.resolve(false);
		this.#closed = new Promise((resolve) => {
			this.#finish = resolve;
		});
		current.failStartup(new AppError("CLOSED"));
		current.state = "stopping";
		current.host.close();
		clearTimeout(current.startupTimer);
		current.shutdownTimer = setTimeout(() => {
			this.#report("shutdown-timeout");
			current.child.kill();
		}, WAIT_MS);
		try {
			current.child.postMessage(encode({ generation: current.generation, kind: "shutdown" }));
		} catch {
			current.child.kill();
		}
		return this.#closed;
	}
}
