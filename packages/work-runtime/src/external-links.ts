/** Host-only external opening capability, independent of the runtime wire protocol. */
export const EXTERNAL_LINK_MAX_BYTES = 8192;
export type ExternalLinkResult = "opened" | "denied" | "unsupported" | "busy" | "failed" | "unknown";
export interface ExternalLinkClient {
	readonly supported: boolean;
	open(url: string): Promise<ExternalLinkResult>;
}

/** No resources are fetched. A valid URL is not a claim about the destination's safety. */
export function externalLinkUrl(raw: unknown): string | undefined {
	if (
		typeof raw !== "string" ||
		/[\ud800-\udfff]/u.test(raw) ||
		raw.length > EXTERNAL_LINK_MAX_BYTES ||
		new TextEncoder().encode(raw).byteLength > EXTERNAL_LINK_MAX_BYTES ||
		/[\u0000-\u0020\u007f-\u009f\\]/u.test(raw) ||
		/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(raw) ||
		!/^https?:\/\/[^/?#]/iu.test(raw) ||
		/^https?:\/\/[^/?#]*@/iu.test(raw)
	)
		return undefined;
	try {
		const url = new URL(raw);
		if (!url.hostname || url.username || url.password || !["http:", "https:"].includes(url.protocol))
			return undefined;
		const result = url.href;
		return new TextEncoder().encode(result).byteLength <= EXTERNAL_LINK_MAX_BYTES ? result : undefined;
	} catch {
		return undefined;
	}
}

export function parseExternalLinkRequest(raw: unknown): { version: 1; url: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid external link request");
	const value = raw as Record<string, unknown>;
	const url = externalLinkUrl(value.url);
	if (Object.keys(value).length !== 2 || value.version !== 1 || !url)
		throw new TypeError("Invalid external link request");
	return { version: 1, url };
}

export function parseExternalLinkResult(raw: unknown): ExternalLinkResult {
	if (typeof raw !== "string" || !["opened", "denied", "unsupported", "busy", "failed", "unknown"].includes(raw))
		throw new TypeError("Invalid external link result");
	return raw as ExternalLinkResult;
}
