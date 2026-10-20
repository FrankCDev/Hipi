import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { AppError, LIMITS, type Scope } from "../contracts.ts";
import { previewMessage, textEnd, textOf } from "../history.ts";
import { SEARCH_LIMITS, type SearchHistoryWindow } from "./contracts.ts";

export type SearchSource = Scope & {
	generation: string;
	durableId: number;
	title: string;
	workspaceName: string;
	revision: number;
	archived: boolean;
};
export type IndexPosition = {
	indexedEntry: number;
	pendingEntry: number;
	pendingSlot: number;
	pendingOffset: number;
	upperEntry: number;
};
export type SearchChunk = { messageId: string; offset: number; textLength: number; text: string };
export type SearchReader = Pick<Storage, "scanEntries" | "entry">;
export function checkSearchAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AppError("CLOSED");
}
export async function indexSource(
	storage: SearchReader,
	source: SearchSource,
	initial: IndexPosition,
	signal?: AbortSignal,
): Promise<{ position: IndexPosition; chunks: SearchChunk[]; complete: boolean }> {
	const position = { ...initial };
	const chunks: SearchChunk[] = [];
	let entries = 0;
	let slots = 0;
	while (
		entries < SEARCH_LIMITS.indexEntries &&
		slots < SEARCH_LIMITS.indexSlots &&
		chunks.length < SEARCH_LIMITS.indexChunks
	) {
		checkSearchAbort(signal);
		const page = await storage.scanEntries(
			{
				conversationId: source.durableId as ConversationId,
				minEntryId: (position.pendingEntry || position.indexedEntry + 1) as EntryId,
				maxEntryId: position.upperEntry as EntryId,
				order: "ascending",
			},
			1,
			undefined,
			context,
		);
		checkSearchAbort(signal);
		const entry = page.items[0];
		if (!entry)
			return {
				position: {
					...position,
					indexedEntry: position.upperEntry,
					pendingEntry: 0,
					pendingSlot: 0,
					pendingOffset: 0,
				},
				chunks,
				complete: true,
			};
		if (position.pendingEntry && position.pendingEntry !== entry.id) throw new AppError("CURSOR_STALE");
		position.pendingEntry = entry.id;
		entries++;
		const model = entry.model ?? [];
		let messageText: string | undefined;
		while (
			position.pendingSlot < model.length &&
			slots < SEARCH_LIMITS.indexSlots &&
			chunks.length < SEARCH_LIMITS.indexChunks
		) {
			checkSearchAbort(signal);
			const message = model[position.pendingSlot];
			slots++;
			if (message?.role === "user" || message?.role === "assistant") {
				// Public Storage materializes a whole entry and textOf assembles the whole message.
				// Reuse only within this entry/step; a resumed step assembles again rather than retaining full text.
				messageText ??= textOf(message);
				const text = messageText;
				if (position.pendingOffset > text.length) throw new AppError("CURSOR_STALE");
				const offset = position.pendingOffset;
				const end = textEnd(text, offset, SEARCH_LIMITS.chunk);
				chunks.push({
					messageId: `${entry.id}_${position.pendingSlot}`,
					offset,
					textLength: text.length,
					text: text.slice(offset, end),
				});
				if (end < text.length) {
					let next = end - SEARCH_LIMITS.overlap;
					if (/[\uDC00-\uDFFF]/.test(text[next] ?? "") && /[\uD800-\uDBFF]/.test(text[next - 1] ?? "")) next--;
					position.pendingOffset = next;
					continue;
				}
			}
			position.pendingSlot++;
			position.pendingOffset = 0;
			messageText = undefined;
		}
		if (position.pendingSlot === model.length) {
			position.indexedEntry = entry.id;
			position.pendingEntry = 0;
			position.pendingSlot = 0;
			position.pendingOffset = 0;
		}
	}
	return { position, chunks, complete: position.indexedEntry >= position.upperEntry && !position.pendingEntry };
}

export type MatchLocator = Scope & {
	storeId: string;
	generation: string;
	durableId: number;
	messageId: string;
	start: number;
	end: number;
	match: string;
	textLength: number;
};
export type WindowPosition = { entry: number; slot: number; direction: "older" | "newer"; fence: number };
export function encodeSearchToken(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeSearchToken(raw: string): Record<string, unknown> {
	try {
		if (raw.length > LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
		const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new AppError("INVALID_REQUEST");
	}
}
export function searchInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("INVALID_REQUEST");
	return value;
}
export function parseLocator(raw: string, source: SearchSource, storeId: string): MatchLocator {
	const p = decodeSearchToken(raw);
	if (
		Object.keys(p).sort().join() !==
			"conversationId,durableId,end,generation,match,messageId,start,storeId,textLength,workspaceId" ||
		p.storeId !== storeId ||
		p.workspaceId !== source.workspaceId ||
		p.conversationId !== source.conversationId ||
		typeof p.messageId !== "string" ||
		!/^[1-9]\d*_(0|[1-9]\d*)$/.test(p.messageId) ||
		typeof p.match !== "string" ||
		!/^[a-f0-9]{64}$/.test(p.match)
	)
		throw new AppError("INVALID_REQUEST");
	if (p.generation !== source.generation || p.durableId !== source.durableId) throw new AppError("CURSOR_STALE");
	const start = searchInteger(p.start),
		end = searchInteger(p.end),
		textLength = searchInteger(p.textLength);
	if (end <= start || end > textLength || end - start > SEARCH_LIMITS.query * 2) throw new AppError("INVALID_REQUEST");
	return { ...source, storeId, messageId: p.messageId, start, end, match: p.match, textLength };
}
export async function historyAroundMatch(
	storage: SearchReader,
	source: SearchSource,
	locator: MatchLocator,
	rawLocator: string,
	cursor?: string,
	signal?: AbortSignal,
): Promise<SearchHistoryWindow> {
	checkSearchAbort(signal);
	const [entryId, slot] = locator.messageId.split("_").map(Number);
	if (!entryId || slot === undefined || !Number.isSafeInteger(entryId) || !Number.isSafeInteger(slot))
		throw new AppError("INVALID_REQUEST");
	const targetEntry = (await storage.entry(source.durableId as ConversationId, entryId as EntryId, context))?.entry;
	const targetMessage = targetEntry?.model?.[slot];
	if (!targetMessage || (targetMessage.role !== "user" && targetMessage.role !== "assistant"))
		throw new AppError("CURSOR_STALE");
	const full = textOf(targetMessage);
	if (
		full.length !== locator.textLength ||
		createHash("sha256").update(full.slice(locator.start, locator.end)).digest("hex") !== locator.match
	)
		throw new AppError("CURSOR_STALE");
	const newest = await storage.scanEntries(
		{ conversationId: source.durableId as ConversationId },
		1,
		undefined,
		context,
	);
	let fence: number = newest.items[0]?.id ?? entryId;
	const locatorDigest = createHash("sha256").update(rawLocator).digest("hex");
	let position: WindowPosition | undefined;
	if (cursor) {
		const p = decodeSearchToken(cursor);
		if (
			Object.keys(p).sort().join() !== "direction,entry,fence,locator,slot" ||
			p.locator !== locatorDigest ||
			(p.direction !== "older" && p.direction !== "newer")
		)
			throw new AppError("INVALID_REQUEST");
		fence = searchInteger(p.fence);
		position = { entry: searchInteger(p.entry), slot: searchInteger(p.slot), direction: p.direction, fence };
		if (!position.entry || position.entry > fence || entryId > fence) throw new AppError("INVALID_REQUEST");
	}
	const read = async (start: WindowPosition, maximum: number) => {
		const messages = [];
		let current = start;
		let scanned = 0,
			slots = 0;
		while (messages.length < maximum && scanned < LIMITS.historyScanEntries && slots < LIMITS.historyScanSlots) {
			checkSearchAbort(signal);
			const page = await storage.scanEntries(
				{
					conversationId: source.durableId as ConversationId,
					...(current.direction === "older"
						? { maxEntryId: current.entry as EntryId }
						: { minEntryId: current.entry as EntryId, maxEntryId: fence as EntryId }),
					order: current.direction === "older" ? "descending" : "ascending",
				},
				1,
				undefined,
				context,
			);
			const entry = page.items[0];
			if (!entry) return { messages, next: null };
			scanned++;
			const model = entry.model ?? [];
			let index =
				entry.id === current.entry
					? current.slot
					: current.direction === "older"
						? Math.max(0, model.length - 1)
						: 0;
			if (current.direction === "older") index = Math.min(index, model.length - 1);
			while (index >= 0 && index < model.length && slots < LIMITS.historyScanSlots && messages.length < maximum) {
				const message = previewMessage(entry, index);
				if (message) messages.push(message);
				slots++;
				index += current.direction === "older" ? -1 : 1;
			}
			if (index >= 0 && index < model.length) {
				current = { ...current, entry: entry.id, slot: index };
			} else {
				if (
					(current.direction === "older" && entry.id === 1) ||
					(current.direction === "newer" && entry.id >= fence)
				)
					return { messages, next: null };
				current = {
					...current,
					entry: entry.id + (current.direction === "older" ? -1 : 1),
					slot: current.direction === "older" ? Number.MAX_SAFE_INTEGER : 0,
				};
			}
		}
		return { messages, next: encodeSearchToken({ ...current, locator: locatorDigest }) };
	};
	const older =
		!position || position.direction === "older"
			? await read(position ?? { entry: entryId, slot, direction: "older", fence }, position ? 32 : 16)
			: undefined;
	const newer =
		!position || position.direction === "newer"
			? await read(position ?? { entry: entryId, slot: slot + 1, direction: "newer", fence }, position ? 32 : 16)
			: undefined;
	checkSearchAbort(signal);
	let offset = Math.max(0, locator.start - 128);
	if (/[\uDC00-\uDFFF]/.test(full[offset] ?? "") && /[\uD800-\uDBFF]/.test(full[offset - 1] ?? "")) offset--;
	const end = textEnd(full, offset, LIMITS.textChunk);
	return {
		workspaceId: source.workspaceId,
		conversationId: source.conversationId,
		messages: [...(older?.messages.reverse() ?? []), ...(newer?.messages ?? [])],
		target: {
			workspaceId: source.workspaceId,
			conversationId: source.conversationId,
			messageId: locator.messageId,
			text: full.slice(offset, end),
			offset,
			nextOffset: end < full.length ? end : null,
			textLength: full.length,
		},
		matchStart: locator.start,
		matchEnd: locator.end,
		olderCursor: older?.next ?? null,
		newerCursor: newer?.next ?? null,
	};
}
