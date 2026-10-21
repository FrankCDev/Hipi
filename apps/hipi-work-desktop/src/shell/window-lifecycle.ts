/** A quit request cannot close the runtime: only an actually closed, unload-approved window can. */
export class WindowLifecycle {
	readonly #requestClose: () => void;
	readonly #shutdown: () => Promise<boolean>;
	#completion?: Promise<boolean>;
	constructor(requestClose: () => void, shutdown: () => Promise<boolean>) {
		this.#requestClose = requestClose;
		this.#shutdown = shutdown;
	}
	requestQuit() {
		if (!this.#completion) this.#requestClose();
	}
	windowClosed(): Promise<boolean> {
		this.#completion ??= this.#shutdown();
		return this.#completion;
	}
}
