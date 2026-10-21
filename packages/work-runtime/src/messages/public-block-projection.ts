import type { Message as PiMessage } from "@earendil-works/pi-ai";
import {
	type MessagePublicBlock,
	type MessagePublicBlocks,
	PUBLIC_BLOCK_LIMITS,
	publicBlocksBytes,
	publicTextBoundary,
} from "./public-blocks.ts";

/** Same immutable model message and canonical text as the existing body reader. No extra reads or text copies. */
export function projectPublicBlocks(
	message: PiMessage,
	text: string,
	toolCalls?: { items: readonly { contentIndex: number }[]; total: number },
): MessagePublicBlocks {
	const items: MessagePublicBlock[] = [];
	let total = 0;
	let offset = 0;
	let omitted = false;
	const content =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	for (const [contentIndex, part] of content.entries()) {
		if (part.type !== "text" && part.type !== "toolCall") continue;
		total++;
		const start = offset;
		if (part.type === "text") offset += part.text.length;
		if (omitted) continue;
		const item: MessagePublicBlock =
			part.type === "text" ? { kind: "text", contentIndex, start, end: offset } : { kind: "tool", contentIndex };
		if (
			items.length >= PUBLIC_BLOCK_LIMITS.items ||
			(part.type === "text" && (!publicTextBoundary(text, start) || !publicTextBoundary(text, offset))) ||
			(part.type === "toolCall" && !toolCalls?.items.some((tool) => tool.contentIndex === contentIndex)) ||
			// Reserve the longest possible final count before deciding which prefix fits.
			publicBlocksBytes({ items: [...items, item], total: content.length, omitted: false }) >
				PUBLIC_BLOCK_LIMITS.bytes
		)
			omitted = true;
		else items.push(item);
	}
	return { items, total, omitted };
}
