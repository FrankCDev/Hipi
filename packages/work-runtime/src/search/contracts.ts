import type { Message, MessageTextChunk, Scope } from "../contracts.ts";

/** Work limits, not a promise about upstream entry materialization or whole-corpus latency. */
export const SEARCH_LIMITS = {
	query: 256,
	chunk: 4096,
	overlap: 512,
	indexChunks: 32,
	indexEntries: 32,
	indexSlots: 256,
	queryChunks: 128,
	results: 50,
	snippet: 512,
} as const;
export type SearchIndexStatus = {
	generation: string;
	state: "building" | "refreshing" | "ready";
	/** Last completed traversal, not a global atomic snapshot of every workspace. */
	completedAt: number | null;
	nextCursor: string | null;
};
export type ConversationSearchHit = Scope & {
	title: string;
	workspaceName: string;
	snippet: string;
	/** UTF-16 offset of snippet in the original title/message. */
	snippetOffset: number;
	matchStart: number;
	matchEnd: number;
} & ({ kind: "title" } | { kind: "message"; messageId: string; locator: string });
export type ConversationSearchPage = {
	items: ConversationSearchHit[];
	index: SearchIndexStatus;
	/** May be non-null on an empty page. Only exhausted, ready coverage means no results. */
	nextCursor: string | null;
};
export type SearchHistoryWindow = Scope & {
	messages: Message[];
	target: MessageTextChunk;
	matchStart: number;
	matchEnd: number;
	olderCursor: string | null;
	newerCursor: string | null;
};
export type SearchMethods = {
	refreshConversationSearch: { params: { cursor?: string }; result: SearchIndexStatus };
	searchConversations: { params: { query: string; cursor?: string }; result: ConversationSearchPage };
	getHistoryAroundMatch: {
		params: Scope & { locator: string; cursor?: string };
		result: SearchHistoryWindow;
	};
};
export function isSearchMethod(value: unknown): value is keyof SearchMethods {
	return value === "refreshConversationSearch" || value === "searchConversations" || value === "getHistoryAroundMatch";
}
export function searchQuery(value: unknown): string {
	if (typeof value !== "string" || value.length > SEARCH_LIMITS.query || /[\ud800-\udfff]/u.test(value))
		throw new Error("INVALID_REQUEST");
	const query = value.trim();
	if (!query) throw new Error("INVALID_REQUEST");
	return query;
}
