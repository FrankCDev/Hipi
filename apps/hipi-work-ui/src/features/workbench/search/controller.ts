import {
	type AppClient,
	AppError,
	type ConversationSearchHit,
	type ConversationSearchPage,
	type SearchIndexStatus,
} from "@hipi/work-runtime/contracts";

export type ConversationSearchState = {
	query: string;
	items: ConversationSearchHit[];
	index?: SearchIndexStatus;
	queryGeneration?: string;
	loading: boolean;
	refreshing: boolean;
	failed: boolean;
	refreshFailed: boolean;
	nextCursor: string | null;
	scanLimited: boolean;
	hasPrevious: boolean;
};

// Result payloads are bounded independently of how far a search is explored.
// Backward navigation replays opaque cursors, rather than retaining an unbounded
// cursor/result ledger. Each demand performs at most one bounded scan batch.
export const SEARCH_RESULT_WINDOW_PAGES = 8;
const SEARCH_SCAN_BATCH = 16;
type ResultPage = { nextCursor: string | null; ordinal: number; previous: boolean; items: ConversationSearchHit[] };
type PreviousReplay = { cursor?: string; ordinal: number; target: number; candidate?: ResultPage };

export function searchHitKey(hit: ConversationSearchHit) {
	return JSON.stringify([
		hit.workspaceId,
		hit.conversationId,
		hit.kind,
		hit.kind === "message" ? hit.messageId : "",
		hit.matchStart,
	]);
}

/** Projection reads and index traversal have separate cancellation/lifecycle owners.
 * Query replacement never starts a Harness or rewinds an in-progress index traversal.
 */
export class ConversationSearchController {
	private state: ConversationSearchState = {
		query: "",
		items: [],
		loading: false,
		refreshing: false,
		failed: false,
		refreshFailed: false,
		nextCursor: null,
		scanLimited: false,
		hasPrevious: false,
	};
	private readonly listeners = new Set<() => void>();
	private queryRequest?: AbortController;
	private refreshRequest?: AbortController;
	private queryTimer?: ReturnType<typeof setTimeout>;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private checkpointTimer?: ReturnType<typeof setTimeout>;
	private yieldTimer?: ReturnType<typeof setTimeout>;
	private resolveYield?: () => void;
	private active = false;
	private composing = false;
	private lastRefresh = 0;
	private readonly seen = new Set<string>();
	private pages: ResultPage[] = [];
	private nextOrdinal = 0;
	private previousReplay?: PreviousReplay;

	constructor(privateClient: AppClient) {
		this.client = privateClient;
	}
	private readonly client: AppClient;
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	activate() {
		this.active = true;
		this.refresh();
	}

	setQuery(value: string, composing = false) {
		this.composing = composing;
		this.queryRequest?.abort();
		this.queryRequest = undefined;
		clearTimeout(this.queryTimer);
		clearTimeout(this.refreshTimer);
		this.seen.clear();
		this.pages = [];
		this.nextOrdinal = 0;
		this.previousReplay = undefined;
		this.set({
			query: value.trim(),
			items: [],
			queryGeneration: undefined,
			nextCursor: null,
			loading: !!value.trim() && !composing,
			failed: false,
			scanLimited: false,
			hasPrevious: false,
		});
		if (!this.active || composing || !value.trim()) return;
		this.queryTimer = setTimeout(() => this.restart(), 180);
		// A sustained new typing session can refresh changed conversations, without
		// tying index ownership to each key or cancelling its current checkpoint.
		this.refreshTimer = setTimeout(() => {
			if (Date.now() - this.lastRefresh >= 2000) this.refresh();
		}, 750);
	}

	restart = () => {
		clearTimeout(this.queryTimer);
		this.queryRequest?.abort();
		this.queryRequest = undefined;
		this.seen.clear();
		if (!this.active || this.composing || !this.state.query) return;
		this.pages = [];
		this.nextOrdinal = 0;
		this.previousReplay = undefined;
		// Keep the current view during index checkpoints; swap only after the
		// replacement read arrives, rather than flashing an empty list.
		this.set({ nextCursor: null, scanLimited: false, failed: false, hasPrevious: false });
		this.load();
	};

	loadMore = () => {
		if (this.active && !this.composing && this.state.nextCursor && !this.queryRequest) {
			this.previousReplay = undefined;
			this.set({ failed: false, scanLimited: false });
			this.load(this.state.nextCursor);
		}
	};

	loadPrevious = () => {
		if (!this.active || this.composing || !this.state.hasPrevious || this.queryRequest) return;
		const first = this.pages[0];
		if (!first) return;
		this.previousReplay ??= { ordinal: 0, target: first.ordinal };
		const request = new AbortController();
		this.queryRequest = request;
		this.set({ loading: true, failed: false, scanLimited: false });
		void this.replayPrevious(request, this.previousReplay);
	};

	refresh = () => {
		if (!this.active || this.refreshRequest) return;
		const request = new AbortController();
		this.refreshRequest = request;
		this.set({ refreshing: true, refreshFailed: false });
		void this.buildIndex(request);
	};

	dispose() {
		this.active = false;
		this.queryRequest?.abort();
		this.refreshRequest?.abort();
		this.queryRequest = undefined;
		this.refreshRequest = undefined;
		clearTimeout(this.queryTimer);
		clearTimeout(this.refreshTimer);
		clearTimeout(this.checkpointTimer);
		this.checkpointTimer = undefined;
		clearTimeout(this.yieldTimer);
		this.resolveYield?.();
		this.resolveYield = undefined;
		this.previousReplay = undefined;
		this.pages = [];
		this.seen.clear();
	}

	private async buildIndex(request: AbortController) {
		let cursor: string | undefined;
		const seen = new Set<string>();
		let restarted = false;
		try {
			while (this.active && this.refreshRequest === request) {
				let index: SearchIndexStatus;
				try {
					index = await this.client.call("refreshConversationSearch", cursor ? { cursor } : {}, request.signal);
				} catch (error) {
					if (error instanceof AppError && error.code === "CURSOR_STALE" && !restarted) {
						cursor = undefined;
						seen.clear();
						restarted = true;
						continue;
					}
					throw error;
				}
				if (!this.active || this.refreshRequest !== request) return;
				if (index.nextCursor && (index.nextCursor === cursor || seen.has(index.nextCursor)))
					throw new AppError("INVALID_REQUEST");
				this.set({ index });
				if (index.nextCursor === null) {
					this.lastRefresh = Date.now();
					clearTimeout(this.checkpointTimer);
					this.checkpointTimer = undefined;
					this.restart();
					break;
				}
				seen.add(index.nextCursor);
				cursor = index.nextCursor;
				if (this.checkpointTimer === undefined) {
					this.checkpointTimer = setTimeout(() => {
						this.checkpointTimer = undefined;
						if (this.active && !this.queryRequest) this.restart();
					}, 300);
				}
				// Yield between bounded storage batches so input and cancellation can run.
				await new Promise<void>((resolve) => {
					this.resolveYield = resolve;
					this.yieldTimer = setTimeout(() => {
						this.resolveYield = undefined;
						this.yieldTimer = undefined;
						resolve();
					}, 0);
				});
			}
		} catch {
			if (this.active && this.refreshRequest === request) this.set({ refreshFailed: true });
		} finally {
			if (this.active && this.refreshRequest === request) {
				this.refreshRequest = undefined;
				this.set({ refreshing: false });
			}
		}
	}

	private load(initialCursor?: string) {
		const request = new AbortController();
		this.queryRequest = request;
		this.set({ loading: true, failed: false });
		void this.query(initialCursor, request);
	}

	private async query(initialCursor: string | undefined, request: AbortController) {
		const query = this.state.query;
		let cursor = initialCursor;
		let restarted = false;
		try {
			for (let pageCount = 0; pageCount < SEARCH_SCAN_BATCH; pageCount++) {
				let page: ConversationSearchPage;
				try {
					page = await this.client.call(
						"searchConversations",
						{ query, ...(cursor ? { cursor } : {}) },
						request.signal,
					);
				} catch (error) {
					if (!this.active || this.queryRequest !== request) return;
					if (error instanceof AppError && error.code === "CURSOR_STALE" && !restarted) {
						restarted = true;
						cursor = undefined;
						pageCount = -1;
						this.seen.clear();
						this.pages = [];
						this.nextOrdinal = 0;
						this.previousReplay = undefined;
						this.set({ items: [], queryGeneration: undefined, nextCursor: null, hasPrevious: false });
						continue;
					}
					throw error;
				}
				if (!this.active || this.queryRequest !== request) return;
				if (page.nextCursor && (page.nextCursor === cursor || this.seen.has(page.nextCursor)))
					throw new AppError("INVALID_REQUEST");
				if (this.pages.length && page.index.generation !== this.state.queryGeneration)
					throw new AppError("CURSOR_STALE");
				if (page.items.length) {
					this.pages.push({
						nextCursor: page.nextCursor,
						ordinal: this.nextOrdinal,
						previous: this.pages.length > 0,
						items: page.items,
					});
					if (this.pages.length > SEARCH_RESULT_WINDOW_PAGES) this.pages.shift();
				}
				this.nextOrdinal++;
				this.set({
					items: page.items.length || !this.pages.length ? this.windowItems() : this.state.items,
					hasPrevious: this.pages[0]?.previous ?? false,
					index: this.refreshRequest ? (this.state.index ?? page.index) : page.index,
					queryGeneration: page.index.generation,
					nextCursor: page.nextCursor,
				});
				if (cursor) this.seen.add(cursor);
				// A bounded recent ledger catches immediate/cyclic server cursors;
				// the scan budget also prevents a long cycle from becoming a hot loop.
				if (this.seen.size > SEARCH_SCAN_BATCH * SEARCH_RESULT_WINDOW_PAGES)
					this.seen.delete(this.seen.values().next().value ?? "");
				if (page.items.length || !page.nextCursor) return;
				cursor = page.nextCursor;
			}
			this.set({ scanLimited: true });
		} catch {
			if (this.active && this.queryRequest === request) this.set({ failed: true });
		} finally {
			if (this.active && this.queryRequest === request) {
				this.queryRequest = undefined;
				this.set({ loading: false });
			}
		}
	}

	private windowItems() {
		return [...new Map(this.pages.flatMap((page) => page.items).map((hit) => [searchHitKey(hit), hit])).values()];
	}

	private async replayPrevious(request: AbortController, replay: PreviousReplay) {
		const seen = new Set<string>();
		try {
			for (let count = 0; count < SEARCH_SCAN_BATCH && replay.ordinal < replay.target; count++) {
				const cursor = replay.cursor;
				const page = await this.client.call(
					"searchConversations",
					{ query: this.state.query, ...(cursor ? { cursor } : {}) },
					request.signal,
				);
				if (!this.active || this.queryRequest !== request) return;
				if (page.index.generation !== this.state.queryGeneration) throw new AppError("CURSOR_STALE");
				if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor)))
					throw new AppError("INVALID_REQUEST");
				if (cursor) seen.add(cursor);
				if (page.items.length)
					replay.candidate = {
						nextCursor: page.nextCursor,
						ordinal: replay.ordinal,
						previous: !!replay.candidate,
						items: page.items,
					};
				replay.ordinal++;
				replay.cursor = page.nextCursor ?? undefined;
				if (!page.nextCursor && replay.ordinal < replay.target) throw new AppError("CURSOR_STALE");
			}
			if (replay.ordinal < replay.target) {
				this.set({ scanLimited: true });
				return;
			}
			if (replay.candidate) {
				this.pages.unshift(replay.candidate);
				if (this.pages.length > SEARCH_RESULT_WINDOW_PAGES) this.pages.pop();
				const last = this.pages.at(-1);
				this.nextOrdinal = (last?.ordinal ?? -1) + 1;
				this.seen.clear();
				this.set({ items: this.windowItems(), nextCursor: last?.nextCursor ?? null });
			}
			this.previousReplay = undefined;
			this.set({ hasPrevious: replay.candidate?.previous ?? false });
		} catch (error) {
			if (this.active && this.queryRequest === request) {
				if (error instanceof AppError && error.code === "CURSOR_STALE") {
					this.restart();
					return;
				}
				this.set({ failed: true });
			}
		} finally {
			if (this.active && this.queryRequest === request) {
				this.queryRequest = undefined;
				this.set({ loading: false });
			}
		}
	}

	private set(update: Partial<ConversationSearchState>) {
		this.state = { ...this.state, ...update };
		for (const listener of this.listeners) listener();
	}
}
