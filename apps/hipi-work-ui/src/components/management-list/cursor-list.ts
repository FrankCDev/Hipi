import { AppError } from "@hipi/work-runtime/contracts";

export type CursorPage<T> = { items: T[]; nextCursor: string | null };
type StoredPage<T> = CursorPage<T> & { cursor: string | undefined };
export type CursorListState<T> = {
	pages: StoredPage<T>[];
	before: number;
	busy: boolean;
	failed: boolean;
	loaded: boolean;
};
/** Three transport pages, no unbounded cursor index. Reverse traversal replays read-only cursors. */
export class ManagementCursorList<T> {
	private state: CursorListState<T> = { pages: [], before: 0, busy: false, failed: false, loaded: false };
	private listeners = new Set<() => void>();
	private request: AbortController | null = null;
	private active = false;
	private replay: { boundary: string | undefined; before: number; index: number; cursor: string | undefined } | null =
		null;
	private cycleCursor: string | null = null;
	private cyclePower = 1;
	private cycleLength = 0;
	private retryDirection: "next" | "previous" | "refresh" = "refresh";
	private readonly readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>;
	constructor(readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>) {
		this.readPage = readPage;
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private publish(patch: Partial<CursorListState<T>>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	setActive(active: boolean) {
		this.active = active;
		if (!active) {
			this.request?.abort();
			this.request = null;
			this.publish({ busy: false });
		}
	}
	reset() {
		this.replay = null;
		this.cycleCursor = null;
		this.cyclePower = 1;
		this.cycleLength = 0;
		this.request?.abort();
		this.request = null;
		this.publish({ pages: [], before: 0, busy: false, failed: false, loaded: false });
	}
	private async page(cursor: string | undefined, signal: AbortSignal) {
		const result = await this.readPage(cursor, signal);
		signal.throwIfAborted();
		if (result.nextCursor !== null && result.nextCursor === cursor) throw new Error("CURSOR_NO_PROGRESS");
		return { ...result, cursor };
	}
	load = async (direction: "next" | "previous" | "refresh" = "next", canCommit?: (items: readonly T[]) => boolean) => {
		if (!this.active || this.request) return;
		const previous = this.state;
		const tail = previous.pages.at(-1);
		if (direction === "next" && previous.loaded && tail?.nextCursor === null) return;
		if (direction === "previous" && previous.before === 0) return;
		if (direction === "refresh") this.replay = null;
		this.retryDirection = direction;
		const request = new AbortController();
		this.request = request;
		this.publish({ busy: true, failed: false });
		const timeout = setTimeout(() => request.abort(), 15000);
		let abort: (() => void) | undefined;
		const read = async () => {
			let pages: StoredPage<T>[];
			let before = previous.before;
			let restarted = false;
			try {
				if (direction === "previous") {
					// Replay has one checkpoint and a per-demand scan budget, so a long history
					// cannot become permanently unreachable merely because one scan times out.
					const boundary = previous.pages[0]?.cursor;
					let replay =
						this.replay && this.replay.boundary === boundary && this.replay.before === before
							? this.replay
							: { boundary, before, index: 0, cursor: undefined };
					let page: StoredPage<T> | undefined;
					for (let scanned = 0; scanned < 16; scanned++) {
						page = await this.page(replay.cursor, request.signal);
						if (replay.index >= before - 1 || !page.nextCursor) break;
						replay = { ...replay, index: replay.index + 1, cursor: page.nextCursor };
						this.replay = replay;
						if (scanned === 15) return;
					}
					if (!page) return;
					this.replay = null;
					if (page.nextCursor !== previous.pages[0]?.cursor) {
						// Mutable queue changed during replay. Publish one coherent head, never stitch generations.
						pages = [await this.page(undefined, request.signal)];
						before = 0;
					} else {
						pages = [page, ...previous.pages].slice(0, 3);
						before--;
					}
				} else if (direction === "refresh") {
					// Refresh the current contiguous window atomically, retaining scroll anchors by stable item identity.
					pages = [];
					let cursor = previous.pages[0]?.cursor;
					for (let index = 0; index < Math.max(1, previous.pages.length); index++) {
						const page = await this.page(cursor, request.signal);
						pages.push(page);
						if (!page.nextCursor) break;
						cursor = page.nextCursor;
					}
				} else {
					const page = await this.page(tail?.nextCursor ?? undefined, request.signal);
					if (previous.pages.some((item) => item.cursor === page.nextCursor && page.nextCursor !== null))
						throw new Error("CURSOR_CYCLE");
					pages = [...previous.pages, page];
					if (pages.length > 3) {
						pages.shift();
						before++;
					}
				}
			} catch (error) {
				if (!(error instanceof AppError) || error.code !== "CURSOR_STALE") throw error;
				this.replay = null;
				pages = [await this.page(undefined, request.signal)];
				before = 0;
				restarted = true;
			}
			request.signal.throwIfAborted();
			if (this.request === request) {
				if (canCommit && !canCommit(pages.flatMap((page) => page.items))) return;
				// Brent-style cycle detection retains one cursor, not the entire traversed chain.
				const next = pages.at(-1)?.nextCursor ?? null;
				if (direction !== "next" || restarted || before < previous.before) {
					this.cycleCursor = null;
					this.cyclePower = 1;
					this.cycleLength = 0;
				} else if (next !== null) {
					if (next === this.cycleCursor) throw new Error("CURSOR_CYCLE");
					this.cycleLength++;
					if (this.cycleLength === this.cyclePower) {
						this.cycleCursor = next;
						this.cyclePower *= 2;
						this.cycleLength = 0;
					}
				}
				this.publish({ pages, before, loaded: true });
			}
		};
		try {
			await Promise.race([
				read(),
				new Promise<never>((_, reject) => {
					abort = () => reject(new Error("READ_ABORTED"));
					request.signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} catch {
			if (this.request === request) this.publish({ failed: true });
		} finally {
			clearTimeout(timeout);
			if (abort) request.signal.removeEventListener("abort", abort);
			if (this.request === request) {
				this.request = null;
				this.publish({ busy: false });
			}
		}
	};
	retry = () => this.load(this.retryDirection);
}
