import {
	type AppearanceClient,
	AppearanceError,
	type AppearanceErrorCode,
	type AppearanceStatus,
	type InstalledFontCatalog,
} from "@hipi/work-runtime/appearance";

export type FontCatalogState =
	| { status: "idle" | "pending" }
	| { status: "ready"; catalog: InstalledFontCatalog }
	| { status: "error"; error: AppearanceErrorCode };

/** A device-local query, never persisted or shared across client/platform identities. */
export class FontCatalogQuery {
	readonly #client: AppearanceClient;
	readonly #listeners = new Set<(state: FontCatalogState) => void>();
	#state: FontCatalogState = { status: "idle" };
	#controller: AbortController | undefined;
	constructor(client: AppearanceClient) {
		this.#client = client;
	}
	snapshot(): FontCatalogState {
		return this.#state;
	}
	#publish(state: FontCatalogState) {
		this.#state = state;
		for (const listener of this.#listeners) listener(state);
	}
	subscribe(listener: (state: FontCatalogState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		if (this.#state.status === "idle") this.retry();
		return () => {
			this.#listeners.delete(listener);
			const controller = this.#controller;
			// StrictMode's cleanup→setup in one turn reuses the same bounded request.
			queueMicrotask(() => {
				if (!this.#listeners.size && controller && this.#controller === controller) {
					this.#controller = undefined;
					controller.abort();
					this.#publish({ status: "error", error: "CLOSED" });
				}
			});
		};
	}
	retry() {
		if (this.#controller || !this.#listeners.size) return;
		const controller = new AbortController();
		this.#controller = controller;
		this.#publish({ status: "pending" });
		void Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) throw new AppearanceError("CLOSED");
				return this.#client.listFonts(controller.signal);
			})
			.then(
				(catalog) => {
					if (this.#controller !== controller || controller.signal.aborted) return;
					this.#controller = undefined;
					this.#publish({ status: "ready", catalog });
				},
				(error: unknown) => {
					if (this.#controller !== controller || controller.signal.aborted) return;
					this.#controller = undefined;
					this.#publish({ status: "error", error: error instanceof AppearanceError ? error.code : "FAILED" });
				},
			);
	}
}
const catalogs = new WeakMap<AppearanceClient, Map<AppearanceStatus["platform"], FontCatalogQuery>>();
export function nativeFontCatalog(
	client: AppearanceClient | undefined,
	platform: AppearanceStatus["platform"] | undefined,
) {
	if (!client?.localFontsSupported || !platform || !["macos", "windows", "linux"].includes(platform)) return undefined;
	let platforms = catalogs.get(client);
	if (!platforms) {
		platforms = new Map();
		catalogs.set(client, platforms);
	}
	let query = platforms.get(platform);
	if (!query) {
		query = new FontCatalogQuery(client);
		platforms.set(platform, query);
	}
	return query;
}
