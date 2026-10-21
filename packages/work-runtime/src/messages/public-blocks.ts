/** Public ordering only; never provider payloads or proof of complete run membership. */
export const PUBLIC_BLOCK_LIMITS = { items: 32, bytes: 2048 } as const;
export type MessagePublicBlock =
	| { kind: "text"; contentIndex: number; start: number; end: number }
	| { kind: "tool"; contentIndex: number };
export type MessagePublicBlocks = { items: MessagePublicBlock[]; total: number; omitted: boolean };
export type PublicBlockContext = {
	/** Canonical text prefix, starting at zero. Full text can revalidate hydrated boundaries. */
	text: string;
	textLength: number;
	toolCalls?: { items: readonly { contentIndex: number }[]; total: number };
};

export function publicBlocksBytes(value: MessagePublicBlocks): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Unknown suffix boundaries are checked when the canonical reader has hydrated them. */
export function publicTextBoundary(text: string, offset: number): boolean {
	return !(
		offset > 0 &&
		offset < text.length &&
		/[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
		/[\uDC00-\uDFFF]/.test(text[offset]!)
	);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error("Invalid public blocks");
	return value as Record<string, unknown>;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid public block count");
	return value;
}

export function parseMessagePublicBlocks(value: unknown, context: PublicBlockContext): MessagePublicBlocks {
	const p = object(value, ["items", "total", "omitted"]);
	if (!Array.isArray(p.items) || p.items.length > PUBLIC_BLOCK_LIMITS.items || typeof p.omitted !== "boolean")
		throw new Error("Invalid public block coverage");
	const total = count(p.total);
	if (total < p.items.length || p.omitted !== total > p.items.length)
		throw new Error("Inconsistent public block coverage");
	if (typeof context.text !== "string" || count(context.textLength) < context.text.length)
		throw new Error("Invalid public block text");
	let previousIndex = -1;
	let previousEnd = 0;
	let tools = 0;
	const items: MessagePublicBlock[] = Array.from(p.items, (raw) => {
		const item = object(raw, ["kind", "contentIndex", "start", "end"]);
		const contentIndex = count(item.contentIndex);
		if (contentIndex <= previousIndex) throw new Error("Invalid public block order");
		previousIndex = contentIndex;
		if (item.kind === "text") {
			const start = count(item.start),
				end = count(item.end);
			if (
				start < previousEnd ||
				start > end ||
				end > context.textLength ||
				(!p.omitted && start !== previousEnd) ||
				!publicTextBoundary(context.text, start) ||
				!publicTextBoundary(context.text, end)
			)
				throw new Error("Invalid public text range");
			previousEnd = end;
			return { kind: "text", contentIndex, start, end };
		}
		if (
			item.kind !== "tool" ||
			"start" in item ||
			"end" in item ||
			!context.toolCalls?.items.some((tool) => tool.contentIndex === contentIndex)
		)
			throw new Error("Invalid public tool reference");
		tools++;
		return { kind: "tool", contentIndex };
	});
	if (!p.omitted && (previousEnd !== context.textLength || tools !== (context.toolCalls?.total ?? 0)))
		throw new Error("Incomplete public block coverage");
	if (total < (context.toolCalls?.total ?? 0) + items.length - tools) throw new Error("Invalid public block total");
	const result = { items, total, omitted: p.omitted };
	if (publicBlocksBytes(result) > PUBLIC_BLOCK_LIMITS.bytes) throw new Error("Public block budget exceeded");
	return result;
}
