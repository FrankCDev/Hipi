import {
	APPEARANCE_LIMITS,
	type AppearanceClient,
	AppearanceError,
	type AppearanceRequest,
	type AppearanceStatus,
	buildInstalledFontCatalog,
	type InstalledFontCatalog,
	parseAppearanceReply,
	parseAppearanceStatus,
	parseFontReply,
	parseInstalledFontFace,
} from "@hipi/work-runtime/appearance";

export interface AppearanceBridge {
	request(input: unknown): Promise<unknown>;
	readonly fontsSupported: boolean;
	listFonts(id: string): Promise<unknown>;
	cancelFonts(id: string): void;
	subscribe(listener: (status: unknown) => void): () => void;
}
declare global {
	interface Window {
		hipiWorkAppearance?: AppearanceBridge;
		queryLocalFonts?: () => Promise<readonly unknown[]>;
	}
}
export const webAppearance: AppearanceStatus = {
	version: 1,
	platform: "web",
	backdrop: "unsupported",
	reducedTransparency: false,
	backdropEnabled: false,
	fontSmoothing: false,
};
/** A timeout or cancellation ends waiting, never claims to revoke a browser permission prompt. */
export function waitForAppearance<T>(operation: Promise<T>, signal?: AbortSignal, deadline = 30000): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error: unknown, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			if (error) reject(error);
			else resolve(value as T);
		};
		const stop = () => finish(new AppearanceError("CLOSED"));
		const timer = setTimeout(stop, deadline);
		signal?.addEventListener("abort", stop, { once: true });
		void operation.then(
			(value) => finish(null, value),
			(error: unknown) => finish(error),
		);
		if (signal?.aborted) stop();
	});
}
/** A bounded metadata list; no font files or catalog are sent to the runtime or persisted. */
export function buildFontCatalog(raw: readonly unknown[]): InstalledFontCatalog {
	let partial = raw.length > APPEARANCE_LIMITS.faces;
	const entries = raw.slice(0, APPEARANCE_LIMITS.faces).map((candidate) => {
		try {
			// FontData is a browser object with prototype accessors, not a plain protocol DTO.
			if (!candidate || typeof candidate !== "object") throw new AppearanceError("INVALID");
			const value = candidate as Record<string, unknown>;
			const face = parseInstalledFontFace({
				family: value.family,
				fullName: value.fullName,
				postscriptName: value.postscriptName,
				style: value.style,
			});
			// Local Font Access exposes no fixed-pitch trait. Do not guess from names or canvas samples.
			return { face, monospace: null };
		} catch {
			partial = true;
			return { face: null, monospace: null };
		}
	});
	return buildInstalledFontCatalog(entries, partial);
}
export function createAppearanceClient(bridge?: AppearanceBridge): AppearanceClient {
	let fontsPending = false;
	const request = async (input: AppearanceRequest, signal?: AbortSignal) => {
		if (signal?.aborted) throw new AppearanceError("CLOSED");
		if (!bridge) {
			if (input.method === "backdrop" && input.enabled) throw new AppearanceError("UNSUPPORTED");
			return webAppearance;
		}
		try {
			return parseAppearanceReply(await waitForAppearance(bridge.request(input), signal, 5000));
		} catch (error) {
			throw error instanceof AppearanceError ? error : new AppearanceError("FAILED");
		}
	};
	return {
		localFontsSupported: bridge ? bridge.fontsSupported : typeof window.queryLocalFonts === "function",
		status: (signal) => request({ version: 1, method: "status" }, signal),
		setBackdrop: (enabled, background, signal) =>
			request({ version: 1, method: "backdrop", enabled, background }, signal),
		subscribe(listener) {
			return (
				bridge?.subscribe((raw) => {
					try {
						listener(parseAppearanceStatus(raw));
					} catch {
						// Ignore malformed or stale native updates.
					}
				}) ?? (() => {})
			);
		},
		async listFonts(signal) {
			if (signal?.aborted) throw new AppearanceError("CLOSED");
			if (bridge ? !bridge.fontsSupported : !window.queryLocalFonts) throw new AppearanceError("UNSUPPORTED");
			if (!bridge && !navigator.userActivation?.isActive) throw new AppearanceError("DENIED");
			if (fontsPending) throw new AppearanceError("BUSY");
			let invoked = false;
			const id = crypto.randomUUID();
			fontsPending = true;
			try {
				// Native host uses only its restricted read-only catalog operation. Browser access is a
				// separate explicit gesture path, never a fallback after a native denial or failure.
				const operation = bridge ? bridge.listFonts(id) : window.queryLocalFonts?.();
				if (!operation) throw new AppearanceError("UNSUPPORTED");
				invoked = true;
				// Admission remains occupied until the actual browser request settles.
				void operation.then(
					() => {
						fontsPending = false;
					},
					() => {
						fontsPending = false;
					},
				);
				const raw = await waitForAppearance(operation, signal);
				if (signal?.aborted) throw new AppearanceError("CLOSED");
				if (bridge) return parseFontReply(raw);
				if (!Array.isArray(raw)) throw new AppearanceError("INVALID");
				return buildFontCatalog(raw);
			} catch (error) {
				if (!invoked) fontsPending = false;
				if (invoked && error instanceof AppearanceError && error.code === "CLOSED") {
					try {
						bridge?.cancelFonts(id);
					} catch {
						// Renderer teardown may have already disposed the restricted bridge.
					}
				}
				if (error instanceof AppearanceError) throw error;
				if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name))
					throw new AppearanceError("DENIED");
				throw new AppearanceError("FAILED");
			}
		},
	};
}
