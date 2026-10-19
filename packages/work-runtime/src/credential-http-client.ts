import { AppError, parseError } from "./contracts.ts";
import { CREDENTIAL_BODY_BYTES, parseCredentialRequest, parseCredentialResponse } from "./credential-contracts.ts";

/** One request per user operation. A timeout is uncertain; set/remove are never retried. */
export function createHttpCredentialBridge(options: { url: string; token: string; origin?: string }) {
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
		throw new AppError("INVALID_REQUEST");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.token}`,
		"Content-Type": "application/json",
	};
	if (options.origin) headers.Origin = options.origin;
	return {
		async request(raw: unknown) {
			const request = parseCredentialRequest(raw);
			try {
				const response = await fetch(`${target.origin}/credentials`, {
					method: "POST",
					headers,
					body: JSON.stringify(request),
					redirect: "error",
					signal: AbortSignal.timeout(10000),
				});
				if (!response.body) throw new AppError("INVALID_REQUEST");
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let text = "";
				let size = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.byteLength;
						if (size > CREDENTIAL_BODY_BYTES) throw new AppError("INVALID_REQUEST");
						text += decoder.decode(chunk.value, { stream: true });
					}
					text += decoder.decode();
				} finally {
					await reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				const value: unknown = JSON.parse(text);
				if (!response.ok) {
					const error =
						value && typeof value === "object" && "error" in value ? parseError(value.error) : "INTERNAL";
					return { ok: false as const, error };
				}
				return parseCredentialResponse(value);
			} catch (error) {
				// Never propagate fetch diagnostics, body fragments or remote exception text.
				return { ok: false as const, error: error instanceof AppError ? error.code : ("CLOSED" as const) };
			}
		},
	};
}
