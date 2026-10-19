import { createPreviewClient, type PreviewClient, type PreviewRequest } from "@hipi/work-runtime/previews/protocol";

export interface DesktopPreviewBridge {
	request(id: string, raw: PreviewRequest): Promise<unknown>;
	cancel(id: string): void;
}
declare global {
	interface Window {
		hipiWorkPreviews?: DesktopPreviewBridge;
	}
}
export function desktopPreviews(bridge: DesktopPreviewBridge, storeId: string): PreviewClient {
	return createPreviewClient({
		storeId,
		request: async (raw, signal) => {
			const id = crypto.randomUUID();
			const cancel = () => {
				try {
					bridge.cancel(id);
				} catch {
					/* A disconnected bridge cannot acknowledge cancellation; the request still stops waiting. */
				}
			};
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				const pending = bridge.request(id, raw);
				if (signal?.aborted) cancel();
				return await pending;
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
	});
}
