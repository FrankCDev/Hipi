import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord, Conversation as PiConversation } from "@earendil-works/pi-durable";
import {
	ACTIVITY_LIMITS,
	AppError,
	type HistoryPage,
	jsonBytes,
	LIMITS,
	type Message,
	type MessageTextChunk,
	type MessageToolCalls,
	type Scope,
} from "./contracts.ts";

/** Offsets and lengths use UTF-16 code units; boundaries never split a surrogate pair. */
export function textOf(message: PiMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
export function textEnd(text: string, start: number, limit: number): number {
	let end = Math.min(text.length, start + limit);
	if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!))
		end--;
	return end;
}
export function previewMessage(entry: EntryRecord, index: number): Message | undefined {
	const message = entry.model?.[index];
	if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
	const text = textOf(message);
	const end = textEnd(text, 0, LIMITS.messagePreview);
	let toolCalls: MessageToolCalls | undefined;
	if (message.role === "assistant") {
		const total = message.content.filter((part) => part.type === "toolCall").length;
		if (total) {
			toolCalls = { items: [], total };
			for (const [contentIndex, part] of message.content.entries()) {
				if (
					part.type !== "toolCall" ||
					!part.id.length ||
					!part.name.length ||
					part.id.length > 256 ||
					part.name.length > 256
				)
					continue;
				if (toolCalls.items.length === ACTIVITY_LIMITS.summaryItems) break;
				const item = { contentIndex, callId: part.id, name: part.name };
				if (jsonBytes({ items: [...toolCalls.items, item], total }) <= ACTIVITY_LIMITS.summaryBytes)
					toolCalls.items.push(item);
			}
		}
	}
	return {
		id: `${entry.id}_${index}`,
		role: message.role,
		text: text.slice(0, end),
		textLength: text.length,
		truncated: end < text.length,
		...(toolCalls ? { toolCalls } : {}),
		...(message.role === "assistant" && message.stopReason === "aborted" ? { interrupted: true as const } : {}),
	};
}
type Position = Scope & { v: 1; fence: number; fenceIndex: number; entry: number; index: number | null };
function encode(position: Position): string {
	return Buffer.from(JSON.stringify(position)).toString("base64url");
}
function decode(raw: string, scope: Scope): Position {
	try {
		if (raw.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		const p = value as Record<string, unknown>;
		if (
			Object.keys(p).sort().join() !== "conversationId,entry,fence,fenceIndex,index,v,workspaceId" ||
			p.v !== 1 ||
			p.workspaceId !== scope.workspaceId ||
			p.conversationId !== scope.conversationId
		)
			throw new Error();
		for (const key of ["fence", "entry", "fenceIndex"] as const)
			if (!Number.isSafeInteger(p[key]) || (p[key] as number) < (key === "fenceIndex" ? -1 : 1)) throw new Error();
		if (p.index !== null && (!Number.isSafeInteger(p.index) || (p.index as number) < 0)) throw new Error();
		if ((p.entry as number) > (p.fence as number)) throw new Error();
		return p as Position;
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
export async function visibleEntry(
	conversation: Pick<PiConversation, "entries">,
	id: number,
): Promise<EntryRecord | undefined> {
	const page = await conversation.entries(
		{ minEntryId: id as EntryId, maxEntryId: id as EntryId },
		1,
		undefined,
		context,
	);
	return page.items[0];
}
/** Uses only fork-aware public history reads. Raw entry materialization remains an upstream memory limitation. */
export async function readHistory(
	conversation: Pick<PiConversation, "entries">,
	scope: Scope,
	cursor?: string,
	upper?: number,
): Promise<HistoryPage> {
	let position: Position;
	if (cursor !== undefined) {
		position = decode(cursor, scope);
		const fence = await visibleEntry(conversation, position.fence);
		if (!fence || position.fenceIndex !== (fence.model?.length ?? 0) - 1) throw new AppError("INVALID_REQUEST");
	} else {
		const newest = await conversation.entries(
			upper === undefined ? {} : { maxEntryId: upper as EntryId },
			1,
			undefined,
			context,
		);
		const entry = newest.items[0];
		if (!entry) return { ...scope, messages: [], nextCursor: null };
		position = {
			...scope,
			v: 1,
			fence: entry.id,
			fenceIndex: (entry.model?.length ?? 0) - 1,
			entry: entry.id,
			index: null,
		};
	}
	const page = await conversation.entries(
		{ maxEntryId: position.entry as EntryId },
		LIMITS.historyScanEntries,
		undefined,
		context,
	);
	if (
		position.index !== null &&
		(page.items[0]?.id !== position.entry || position.index >= (page.items[0]?.model?.length ?? 0))
	)
		throw new AppError("INVALID_REQUEST");
	const messages: Message[] = [];
	let slots = 0;
	let nextCursor: string | null = null;
	for (let e = 0; e < page.items.length; e++) {
		const entry = page.items[e]!;
		const start = e === 0 && position.index !== null ? position.index : (entry.model?.length ?? 0) - 1;
		for (let index = start; index >= 0; index--) {
			if (messages.length === LIMITS.historyMessages || slots === LIMITS.historyScanSlots) {
				nextCursor = encode({ ...position, entry: entry.id, index });
				return { ...scope, messages: messages.reverse(), nextCursor };
			}
			slots++;
			const message = previewMessage(entry, index);
			if (message) messages.push(message);
		}
	}
	if (page.next && page.items.length) {
		const last = page.items.at(-1)!;
		if (last.id > 1) nextCursor = encode({ ...position, entry: last.id - 1, index: null });
	}
	return { ...scope, messages: messages.reverse(), nextCursor };
}
export async function readMessageText(
	conversation: Pick<PiConversation, "entries">,
	scope: Scope,
	messageId: string,
	offset: number,
): Promise<MessageTextChunk> {
	const match = /^([1-9][0-9]*)_(0|[1-9][0-9]*)$/.exec(messageId);
	if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])))
		throw new AppError("INVALID_REQUEST");
	const entry = await visibleEntry(conversation, Number(match[1]));
	const message = entry?.model?.[Number(match[2])];
	if (!message || (message.role !== "user" && message.role !== "assistant")) throw new AppError("NOT_FOUND");
	const full = textOf(message);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.length) throw new AppError("INVALID_REQUEST");
	if (
		offset > 0 &&
		offset < full.length &&
		/[\uD800-\uDBFF]/.test(full[offset - 1]!) &&
		/[\uDC00-\uDFFF]/.test(full[offset]!)
	)
		offset--;
	const end = textEnd(full, offset, LIMITS.textChunk);
	return {
		...scope,
		messageId,
		text: full.slice(offset, end),
		offset,
		nextOffset: end < full.length ? end : null,
		textLength: full.length,
	};
}
