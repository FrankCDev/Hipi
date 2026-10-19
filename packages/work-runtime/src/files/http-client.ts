import { FileServiceError } from "./contracts.ts";
import { createFileClient, FILE_FRAME_BYTES } from "./protocol.ts";

/** Session credentials stay in memory, never URLs or browser storage. No automatic retries. */
export function createHttpFileClient(options: { url: string; token: string; storeId: string; origin?: string }) {
	const target = new URL(options.url);
	if (
		target.protocol !== "http:" ||
		target.hostname !== "127.0.0.1" ||
		target.pathname !== "/" ||
		target.search ||
		target.hash ||
		target.username ||
		target.password
	)
		throw new FileServiceError("INVALID_PATH");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.token}`,
		"Content-Type": "application/json",
	};
	if (options.origin) headers.Origin = options.origin;
	return createFileClient({
		storeId: options.storeId,
		async request(request, signal) {
			const response = await fetch(`${target.origin}/files`, {
				method: "POST",
				headers,
				body: JSON.stringify(request),
				redirect: "error",
				signal,
			});
			if (!response.ok || !response.body || response.headers.get("content-type") !== "application/json")
				throw new FileServiceError("IO_ERROR");
			const reader = response.body.getReader();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let body = "";
			let size = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > FILE_FRAME_BYTES) throw new FileServiceError("LIMIT_EXCEEDED");
					body += decoder.decode(chunk.value, { stream: true });
				}
				body += decoder.decode();
				const result: unknown = JSON.parse(body);
				return result;
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
		},
	});
}
