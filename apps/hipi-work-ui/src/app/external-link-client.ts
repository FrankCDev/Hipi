import {
	type ExternalLinkClient,
	type ExternalLinkResult,
	parseExternalLinkRequest,
	parseExternalLinkResult,
} from "@hipi/work-runtime/external-links";

export interface ExternalLinkBridge {
	open(request: unknown): Promise<unknown>;
}
declare global {
	interface Window {
		hipiWorkExternalLinks?: ExternalLinkBridge;
	}
}

/** No window.open fallback. A denied native capability stays denied. */
export function createExternalLinkClient(bridge?: ExternalLinkBridge): ExternalLinkClient {
	let pending = false;
	return {
		supported: bridge !== undefined,
		async open(url) {
			if (!bridge) return "unsupported";
			if (pending) return "busy";
			let request: ReturnType<typeof parseExternalLinkRequest>;
			try {
				request = parseExternalLinkRequest({ version: 1, url });
			} catch {
				return "denied";
			}
			pending = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const operation = Promise.resolve()
				.then(() => bridge.open(request))
				.then(parseExternalLinkResult)
				.catch((): ExternalLinkResult => "unknown")
				.finally(() => {
					pending = false;
					clearTimeout(timer);
				});
			// A timeout ends waiting, not OS opening or admission. Never automatically retry.
			return Promise.race([
				operation,
				new Promise<ExternalLinkResult>((resolve) => {
					timer = setTimeout(() => resolve("unknown"), 10000);
				}),
			]);
		},
	};
}
