import { AppearanceError, type InstalledFontCatalog } from "@hipi/work-runtime/appearance";

/** Owner lifetime and cancellation IDs are distinct from subprocess admission until actual exit. */
export class FontRequests {
	readonly #list: (signal: AbortSignal) => Promise<InstalledFontCatalog>;
	#active: { id: string; controller: AbortController } | undefined;
	constructor(list: (signal: AbortSignal) => Promise<InstalledFontCatalog>) {
		this.#list = list;
	}
	async request(id: string, trusted: () => boolean): Promise<InstalledFontCatalog> {
		if (!trusted()) throw new AppearanceError("DENIED");
		if (this.#active) throw new AppearanceError("BUSY");
		const call = { id, controller: new AbortController() };
		this.#active = call;
		try {
			const result = await this.#list(call.controller.signal);
			if (call.controller.signal.aborted || !trusted()) throw new AppearanceError("CLOSED");
			return result;
		} finally {
			if (this.#active === call) this.#active = undefined;
		}
	}
	cancel(id: string) {
		if (this.#active?.id === id) this.#active.controller.abort();
	}
	reset() {
		this.#active?.controller.abort();
	}
}
