import { createInterface } from "node:readline";
import { DEVELOPMENT_QUIT, DEVELOPMENT_READY } from "./launch.ts";

/** The owning CLI controls only this child through its private stdin pipe, never renderer IPC. */
export function developmentControl(quit: () => void) {
	const input = createInterface({ input: process.stdin, terminal: false });
	input.on("line", (line) => {
		if (line === DEVELOPMENT_QUIT) quit();
	});
	input.on("close", quit);
	return {
		ready() {
			process.stdout.write(`${DEVELOPMENT_READY}\n`);
		},
		dispose() {
			input.removeAllListeners();
			input.close();
		},
	};
}

/** Startup has no window close owner yet. Transfer ownership only after WindowLifecycle is installed. */
export class DevelopmentLifecycle {
	readonly #stop: () => Promise<boolean>;
	readonly #exit: (clean: boolean) => Promise<void>;
	#windowQuit?: () => void;
	#closing?: Promise<void>;
	#cancelled = false;
	constructor(stop: () => Promise<boolean>, exit: (clean: boolean) => Promise<void>) {
		this.#stop = stop;
		this.#exit = exit;
	}
	get cancelled() {
		return this.#cancelled;
	}
	windowReady(quit: () => void) {
		this.#windowQuit = quit;
	}
	quit(): Promise<void> {
		this.#cancelled = true;
		if (this.#windowQuit) {
			this.#windowQuit();
			return Promise.resolve();
		}
		this.#closing ??= this.#stop().then(this.#exit);
		return this.#closing;
	}
}
