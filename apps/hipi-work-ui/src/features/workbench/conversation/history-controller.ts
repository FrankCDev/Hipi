import {
	AppError,
	type HistoryPage,
	type Message,
	type Scope,
	type SearchHistoryWindow,
	type Snapshot,
} from "@hipi/work-runtime/contracts";

import { mergeRunResults } from "./activity/results.ts";
import {
	fitHistoryWindow,
	fitsHistory,
	HISTORY_CAPACITY,
	HISTORY_PROXIMITY,
	HistoryCursorProgress,
	type HistoryDirection,
	type HistoryViewport,
} from "./history/window.ts";

export { HISTORY_CAPACITY } from "./history/window.ts";
export type ConversationHistoryState = {
	snapshot?: Snapshot;
	loading: boolean;
	failed: boolean;
	reconciling: boolean;
	capacity: boolean;
	blocked: "capacity" | null;
	anchor?: SearchHistoryAnchor;
	newer?: boolean;
};
export type SearchHistoryAnchor = { locator: string; window: SearchHistoryWindow };
type Bridge = {
	snapshot: Snapshot;
	messages: Message[];
	cursor: string | null;
	seen: Set<string>;
	progress: HistoryCursorProgress;
};

/** Validate and project the hydrated window before the first child layout effect can follow the live tail. */
export function anchoredHistorySnapshot(scope: Scope, anchor: SearchHistoryAnchor): Snapshot {
	const { window } = anchor;
	const target = window.messages.find((message) => message.id === window.target.messageId);
	if (
		window.workspaceId !== scope.workspaceId ||
		window.conversationId !== scope.conversationId ||
		window.target.workspaceId !== scope.workspaceId ||
		window.target.conversationId !== scope.conversationId ||
		!target ||
		target.textLength !== window.target.textLength ||
		window.matchStart < window.target.offset ||
		window.matchEnd <= window.matchStart ||
		window.matchEnd > window.target.offset + window.target.text.length ||
		!fitsHistory(window.messages)
	)
		throw new AppError("INVALID_REQUEST");
	return {
		...scope,
		messages: unique(window.messages),
		historyCursor: null,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		running: false,
	};
}

/** One mounted scope owns a bounded preview window and at most one cancellable
 * read. Fences and boundary replay preserve reachability after safe edge eviction;
 * interaction leases stop admission instead of discarding protected content.
 */
export class ConversationHistoryController {
	private readonly scope: Scope;
	private readonly read: (cursor: string, signal: AbortSignal) => Promise<HistoryPage>;
	private readonly publish: (state: ConversationHistoryState) => void;
	private snapshot: Snapshot | undefined;
	private latest: Snapshot | undefined;
	private scanPages = 0;
	private bridge: Bridge | undefined;
	private queued: Snapshot | undefined;
	private request: AbortController | undefined;
	private readonly olderSeen = new Set<string>();
	private olderProgress = new HistoryCursorProgress();
	private anchorProgress = { older: new HistoryCursorProgress(), newer: new HistoryCursorProgress() };
	private nearTop = false;
	private failed = false;
	private capacity = false;
	private disposed = false;
	private connected = true;
	private anchor: SearchHistoryAnchor | undefined;
	private anchorDirection: "older" | "newer" | undefined;
	private readonly anchorSeen = { older: new Set<string>(), newer: new Set<string>() };
	private readonly readAnchor?: (locator: string, cursor: string, signal: AbortSignal) => Promise<SearchHistoryWindow>;
	private viewport: HistoryViewport | null = null;
	private detached = false;
	private recoverOlder = false;
	private anchorSeed: SearchHistoryAnchor | undefined;
	private readonly origins = new Map<string, string | null>();
	private readonly recoverAnchor: Record<HistoryDirection, boolean> = { older: false, newer: false };
	private continuation: ReturnType<typeof setTimeout> | undefined;
	private replayDirection: HistoryDirection | undefined;
	private replayTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		scope: Scope,
		read: (cursor: string, signal: AbortSignal) => Promise<HistoryPage>,
		publish: (state: ConversationHistoryState) => void,
		readAnchor?: (locator: string, cursor: string, signal: AbortSignal) => Promise<SearchHistoryWindow>,
	) {
		this.scope = { ...scope };
		this.read = read;
		this.publish = publish;
		this.readAnchor = readAnchor;
	}

	get state(): ConversationHistoryState {
		return {
			snapshot: this.snapshot,
			loading: this.request !== undefined,
			failed: this.failed,
			reconciling: this.bridge !== undefined || this.queued !== undefined,
			capacity: this.capacity,
			blocked: this.capacity ? "capacity" : null,
			anchor: this.anchor,
			newer: this.detached,
		};
	}

	update(snapshot: Snapshot) {
		if (this.disposed) return;
		this.validateScope(snapshot);
		this.latest = snapshot;
		// A search window is intentionally disconnected from the live tail.
		// Observation remains available for Jump to latest, never as a gap to drain.
		if (this.anchor || this.detached) return;
		if (this.capacity) return;
		if (!this.fits(this.snapshot?.messages ?? [], this.bridge?.messages ?? [], snapshot.messages)) {
			const held = this.snapshot;
			const tail = held?.messages.at(-1);
			const overlap = tail ? snapshot.messages.findIndex((message) => message.id === tail.id) : -1;
			if (held && overlap >= 0 && !this.bridge) {
				const messages = fitHistoryWindow(
					unique([...held.messages, ...snapshot.messages.slice(overlap + 1)]),
					"newer",
					this.viewport,
				);
				if (messages) {
					this.recoverOlder = true;
					this.snapshot = {
						...snapshot,
						messages,
						historyCursor: held.historyCursor,
						runResults: mergeRunResults(held.runResults, snapshot.runResults),
					};
					this.emit();
					return;
				}
			}
			this.capacity = true;
			this.emit();
			return;
		}
		if (this.bridge) this.queued = snapshot;
		else this.acceptLive(snapshot);
		this.emit();
		this.pump();
	}

	setNearTop(nearTop: boolean) {
		if (this.disposed) return;
		this.nearTop = nearTop;
		if (nearTop && this.recoverOlder && !this.anchor) this.startReplay("older");
		else this.pump();
	}

	setConnected(connected: boolean) {
		if (this.disposed || this.connected === connected) return;
		this.connected = connected;
		if (!connected) {
			this.request?.abort();
			this.request = undefined;
			if (this.continuation) clearTimeout(this.continuation);
			this.continuation = undefined;
			if (this.replayTimeout) clearTimeout(this.replayTimeout);
			this.replayTimeout = undefined;
			this.emit();
		} else {
			this.demand();
			this.pump();
		}
	}

	setViewport(viewport: HistoryViewport | null) {
		if (this.disposed) return;
		const previous = this.viewport;
		this.viewport = viewport;
		if (!viewport || viewport.paused) return;
		if (this.capacity) {
			const changed =
				!previous ||
				previous.paused ||
				previous.olderDistance !== viewport.olderDistance ||
				previous.newerDistance !== viewport.newerDistance ||
				previous.pinnedIds.size !== viewport.pinnedIds.size ||
				[...previous.pinnedIds].some((id) => !viewport.pinnedIds.has(id));
			if (!changed) return;
			this.capacity = false;
			this.emit();
			if (this.latest && !this.anchor && !this.detached) this.update(this.latest);
		}
		this.demand();
	}

	private demand() {
		const viewport = this.viewport;
		if (
			!this.connected ||
			!viewport ||
			viewport.paused ||
			this.request ||
			this.failed ||
			this.capacity ||
			this.continuation
		)
			return;
		const older = !!(
			this.anchor?.window.olderCursor ||
			this.recoverAnchor.older ||
			this.snapshot?.historyCursor ||
			this.recoverOlder
		);
		const newer = !!(this.anchor?.window.newerCursor || this.recoverAnchor.newer || this.detached);
		const direction =
			older &&
			viewport.olderDistance <= HISTORY_PROXIMITY &&
			(!newer || viewport.olderDistance <= viewport.newerDistance)
				? "older"
				: newer && viewport.newerDistance <= HISTORY_PROXIMITY
					? "newer"
					: undefined;
		if (!direction) return;
		if (this.anchor) this.loadAnchored(direction);
		else if (direction === "newer" || this.recoverOlder) this.startReplay(direction);
		else this.pump(true);
	}

	private yieldDemand() {
		if (this.continuation || this.disposed) return;
		this.continuation = setTimeout(() => {
			this.continuation = undefined;
			this.scanPages = 0;

			this.demand();
			this.pump();
		}, 0);
	}

	retry() {
		if (this.disposed || !this.failed || this.capacity) return;
		this.failed = false;

		this.scanPages = 0;
		this.emit();
		if (this.replayDirection) {
			this.startReplay(this.replayDirection);
			return;
		}
		if (this.anchor && this.anchorDirection) {
			this.loadAnchored(this.anchorDirection);
			return;
		}
		// An explicit retry also retries an older page after the user has scrolled away.
		this.pump(true);
	}

	resetToLatest() {
		if (this.disposed) return;
		this.request?.abort();
		this.request = undefined;
		if (this.replayTimeout) clearTimeout(this.replayTimeout);
		this.replayTimeout = undefined;
		if (this.continuation) clearTimeout(this.continuation);
		this.continuation = undefined;
		this.detached = false;
		this.recoverOlder = false;
		this.replayDirection = undefined;
		this.origins.clear();
		this.anchorSeed = undefined;
		this.recoverAnchor.older = this.recoverAnchor.newer = false;
		this.snapshot = this.latest ? { ...this.latest, messages: unique(this.latest.messages) } : undefined;
		this.bridge = undefined;
		this.queued = undefined;
		this.olderSeen.clear();
		this.olderProgress = new HistoryCursorProgress();

		this.scanPages = 0;

		this.failed = false;
		this.capacity = false;
		this.nearTop = false;
		this.anchor = undefined;
		this.anchorDirection = undefined;
		this.anchorSeen.older.clear();
		this.anchorSeen.newer.clear();
		this.anchorProgress = { older: new HistoryCursorProgress(), newer: new HistoryCursorProgress() };
		this.emit();
	}

	openAnchor(anchor: SearchHistoryAnchor) {
		if (this.disposed) return;
		const snapshot = anchoredHistorySnapshot(this.scope, anchor);
		this.request?.abort();
		this.request = undefined;
		if (this.replayTimeout) clearTimeout(this.replayTimeout);
		this.replayTimeout = undefined;
		if (this.continuation) clearTimeout(this.continuation);
		this.continuation = undefined;
		this.anchorSeed = anchor;
		this.origins.clear();
		for (const message of snapshot.messages) this.origins.set(message.id, null);
		this.recoverAnchor.older = this.recoverAnchor.newer = false;
		this.detached = false;
		this.recoverOlder = false;
		this.replayDirection = undefined;
		this.anchor = anchor;
		this.anchorDirection = undefined;
		this.anchorSeen.older.clear();
		this.anchorSeen.newer.clear();
		this.anchorProgress = { older: new HistoryCursorProgress(), newer: new HistoryCursorProgress() };
		this.snapshot = snapshot;
		this.bridge = undefined;
		this.queued = undefined;

		this.scanPages = 0;

		this.failed = false;
		this.capacity = false;
		this.nearTop = false;
		this.emit();
	}

	loadAnchored(direction: "older" | "newer") {
		const anchor = this.anchor;
		const cursor = anchor?.window[direction === "older" ? "olderCursor" : "newerCursor"];
		if (
			this.disposed ||
			!this.connected ||
			!anchor ||
			(!cursor && !this.recoverAnchor[direction]) ||
			!this.readAnchor ||
			this.request ||
			this.capacity ||
			this.failed
		)
			return;
		const request = new AbortController();
		this.request = request;
		this.anchorDirection = direction;
		this.failed = false;
		this.emit();
		void this.loadAnchor(anchor, cursor ?? "", direction, request);
	}

	dispose() {
		this.disposed = true;
		this.request?.abort();
		this.request = undefined;
		if (this.replayTimeout) clearTimeout(this.replayTimeout);
		this.replayTimeout = undefined;
		if (this.continuation) clearTimeout(this.continuation);
		this.continuation = undefined;
		this.viewport = null;
		this.origins.clear();
		this.anchorSeed = undefined;
		this.snapshot = undefined;
		this.latest = undefined;
		this.bridge = undefined;
		this.queued = undefined;
		this.olderSeen.clear();
		this.anchor = undefined;
		this.anchorSeen.older.clear();
		this.anchorSeen.newer.clear();
	}

	private validateScope(value: Scope) {
		if (value.workspaceId !== this.scope.workspaceId || value.conversationId !== this.scope.conversationId)
			throw new AppError("INVALID_REQUEST");
	}

	private fits(...groups: Message[][]): boolean {
		return fitsHistory(unique(groups.flat()));
	}

	private acceptLive(incoming: Snapshot) {
		const held = this.snapshot;
		if (!held) {
			this.snapshot = { ...incoming, messages: unique(incoming.messages) };
			return;
		}
		const tail = held.messages.at(-1);
		const overlap = tail ? incoming.messages.findIndex((message) => message.id === tail.id) : -1;
		if (
			overlap >= 0 ||
			(!tail && held.historyCursor === null) ||
			(!tail && incoming.messages.length === 0 && incoming.historyCursor === held.historyCursor)
		) {
			this.snapshot = {
				...incoming,
				runResults: mergeRunResults(held.runResults, incoming.runResults),
				messages: unique([...held.messages, ...incoming.messages.slice(overlap + 1)]),
				historyCursor: !tail && held.historyCursor === null ? incoming.historyCursor : held.historyCursor,
			};
		} else {
			this.bridge = {
				snapshot: incoming,
				messages: unique(incoming.messages),
				cursor: incoming.historyCursor,
				seen: new Set(),
				progress: new HistoryCursorProgress(),
			};
			if (incoming.historyCursor === null) this.failed = true;
		}
	}

	private pump(force = false) {
		if (
			this.disposed ||
			!this.connected ||
			this.anchor ||
			this.request ||
			this.failed ||
			this.capacity ||
			this.continuation ||
			this.viewport?.paused
		)
			return;
		if (this.recoverOlder || (this.detached && !force)) return;
		const bridge = this.bridge;
		const cursor = bridge?.cursor ?? (bridge ? null : this.snapshot?.historyCursor);
		if (!cursor) {
			if (bridge) {
				this.failed = true;
				this.emit();
			}
			return;
		}
		if (!bridge && !this.nearTop && !force) return;
		if (this.scanPages >= 16) {
			this.yieldDemand();
			return;
		}
		const request = new AbortController();
		this.request = request;
		this.emit();
		void this.load(cursor, bridge, request);
	}

	private async loadAnchor(
		anchor: SearchHistoryAnchor,
		cursor: string,
		direction: "older" | "newer",
		request: AbortController,
	) {
		try {
			const recovering = this.recoverAnchor[direction];
			const boundary = direction === "older" ? this.snapshot?.messages[0] : this.snapshot?.messages.at(-1);
			const origin = boundary ? this.origins.get(boundary.id) : undefined;
			const page =
				recovering && origin === null
					? this.anchorSeed?.window
					: await this.readAnchor?.(anchor.locator, recovering ? (origin ?? cursor) : cursor, request.signal);
			if (!page || this.disposed || this.anchor !== anchor || this.request !== request) return;
			this.validateScope(page);
			this.validateScope(page.target);
			if (
				page.target.messageId !== anchor.window.target.messageId ||
				page.target.textLength !== anchor.window.target.textLength ||
				page.matchStart !== anchor.window.matchStart ||
				page.matchEnd !== anchor.window.matchEnd
			)
				throw new AppError("INVALID_REQUEST");
			const field = direction === "older" ? "olderCursor" : "newerCursor";
			const next = page[field];
			if (
				!recovering &&
				next &&
				(!this.anchorProgress[direction].valid(cursor, next) || this.anchorSeen[direction].has(next))
			)
				throw new AppError("INVALID_REQUEST");
			const held = this.snapshot;
			if (!held) return;
			const originals = new Set(held.messages.map((message) => message.id));
			const boundaryIndex = recovering ? page.messages.findIndex((message) => message.id === boundary?.id) : -1;
			if (recovering && boundaryIndex < 0) throw new AppError("INVALID_REQUEST");
			const source = recovering
				? direction === "older"
					? page.messages.slice(0, boundaryIndex)
					: page.messages.slice(boundaryIndex + 1)
				: page.messages;
			const added = source.filter((message) => !originals.has(message.id));
			const combined = unique(direction === "older" ? [...added, ...held.messages] : [...held.messages, ...added]);
			const messages = fitHistoryWindow(combined, direction, this.viewport);
			if (!messages) {
				this.capacity = true;
				return;
			}
			if (!recovering) this.anchorProgress[direction].advance(cursor, next);
			else this.anchorProgress[direction] = new HistoryCursorProgress();
			for (const message of added) this.origins.set(message.id, recovering ? (origin ?? null) : cursor);
			const retained = new Set(messages.map((message) => message.id));
			for (const id of this.origins.keys()) if (!retained.has(id)) this.origins.delete(id);
			this.recoverAnchor[direction] = false;
			if (combined.length !== messages.length) {
				const opposite = direction === "older" ? "newer" : "older";
				this.recoverAnchor[opposite] = true;
				this.anchorSeen[opposite].clear();
				this.anchorProgress[opposite] = new HistoryCursorProgress();
			}
			if (!recovering) this.remember(this.anchorSeen[direction], cursor);
			this.anchor = { ...anchor, window: { ...anchor.window, [field]: next } };
			this.snapshot = { ...held, messages };

			this.anchorDirection = undefined;
			if (added.length === 0) this.yieldDemand();
		} catch {
			if (!this.disposed && this.request === request) this.failed = true;
		} finally {
			if (!this.disposed && this.request === request) {
				this.request = undefined;
				this.emit();
			}
		}
	}

	private async load(cursor: string, bridge: Bridge | undefined, request: AbortController) {
		try {
			const page = await this.read(cursor, request.signal);
			if (this.disposed || request !== this.request || this.capacity) return;
			this.validateScope(page);
			const seen = bridge?.seen ?? this.olderSeen;
			const progress = bridge?.progress ?? this.olderProgress;
			if (page.nextCursor !== null && (!progress.valid(cursor, page.nextCursor) || seen.has(page.nextCursor)))
				throw new AppError("INVALID_REQUEST");
			const held = this.snapshot;
			if (!held) return;
			if (bridge) {
				const messages = unique([...page.messages, ...bridge.messages]);
				const runResults = mergeRunResults(bridge.snapshot.runResults, page.runResults);
				if (!this.fits(held.messages, messages, this.queued?.messages ?? [])) {
					if (!this.viewport) {
						this.capacity = true;
						return;
					}
					// A large live gap cannot be staged atomically in this budget.
					// Keep the held island and recover its newer boundary by replay.
					this.detached = true;
					this.bridge = undefined;
					this.queued = undefined;
					this.snapshot = historyOnly(held);
					this.yieldDemand();
					return;
				}
				const tail = held.messages.at(-1);
				const overlap = tail ? messages.findIndex((message) => message.id === tail.id) : -1;
				if (overlap >= 0 || (!tail && page.nextCursor === null)) {
					this.snapshot = {
						...bridge.snapshot,
						runResults: mergeRunResults(held.runResults, runResults),
						messages: unique([...held.messages, ...messages.slice(overlap + 1)]),
						historyCursor: tail ? held.historyCursor : null,
					};
					this.bridge = undefined;
					this.scanPages = -1;
					const queued = this.queued;
					this.queued = undefined;
					if (queued) this.acceptLive(queued);
				} else {
					if (page.nextCursor === null) throw new AppError("INVALID_REQUEST");
					bridge.snapshot = { ...bridge.snapshot, runResults };
					bridge.messages = messages;
					bridge.cursor = page.nextCursor;
				}
			} else {
				// Held originals win when a page repeats immutable final message IDs.
				const originals = new Set(held.messages.map((message) => message.id));
				const combined = unique([...page.messages.filter((message) => !originals.has(message.id)), ...held.messages]);
				const messages = this.bridge
					? this.fits(combined, this.bridge.messages, this.queued?.messages ?? [])
						? combined
						: undefined
					: fitHistoryWindow(combined, "older", this.viewport);
				if (!messages) {
					this.capacity = true;
					return;
				}
				if (messages.length !== combined.length) this.detached = true;
				this.snapshot = {
					...(this.detached ? historyOnly(held) : held),
					messages,
					historyCursor: page.nextCursor,
					runResults: mergeRunResults(held.runResults, page.runResults),
				};
				if (page.messages.length > 0) {
					this.nearTop = false;
					this.scanPages = -1;
				}
			}
			this.remember(seen, cursor);
			progress.advance(cursor, page.nextCursor);

			this.scanPages++;
		} catch {
			if (!this.disposed && request === this.request) this.failed = true;
		} finally {
			if (!this.disposed && request === this.request) {
				this.request = undefined;
				this.emit();
				this.pump();
			}
		}
	}

	private startReplay(direction: HistoryDirection) {
		if (
			this.disposed ||
			!this.connected ||
			this.request ||
			this.failed ||
			this.capacity ||
			this.viewport?.paused ||
			!this.latest ||
			!this.snapshot
		)
			return;
		const boundary = direction === "older" ? this.snapshot.messages[0] : this.snapshot.messages.at(-1);
		if (!boundary) return;
		const request = new AbortController();
		this.request = request;
		this.replayDirection = direction;
		this.emit();
		void this.replay(this.latest, boundary.id, direction, request);
	}

	/** getHistory is backwards-only. Replay from one immutable latest fence,
	 * retaining one predecessor page, until the held edge is found. No old-page
	 * payload chain or unbounded cursor index survives a read. */
	private async replay(fence: Snapshot, boundaryId: string, direction: HistoryDirection, request: AbortController) {
		const timeout = setTimeout(() => {
			if (this.request !== request || this.disposed) return;
			request.abort();
			this.request = undefined;
			this.failed = true;
			this.emit();
		}, 30_000);
		this.replayTimeout = timeout;
		try {
			let current: HistoryPage = {
				...this.scope,
				messages: fence.messages,
				nextCursor: fence.historyCursor,
				runResults: fence.runResults,
			};
			let previous: HistoryPage | undefined;
			let scanned = 0;
			const seen = new Set<string>();
			const progress = new HistoryCursorProgress();
			for (;;) {
				if (this.disposed || this.request !== request || request.signal.aborted || this.viewport?.paused) return;
				const index = current.messages.findIndex((message) => message.id === boundaryId);
				if (index >= 0) {
					let added =
						direction === "older"
							? current.messages.slice(0, index)
							: [...current.messages.slice(index + 1), ...(previous?.messages ?? [])];
					let olderCursor = current.nextCursor;
					if (direction === "older" && added.length === 0 && olderCursor) {
						const page = await this.read(olderCursor, request.signal);
						this.validateScope(page);
						if (page.nextCursor === olderCursor || (page.nextCursor && seen.has(page.nextCursor)))
							throw new AppError("INVALID_REQUEST");
						added = page.messages;
						olderCursor = page.nextCursor;
					}
					if (this.disposed || this.request !== request || request.signal.aborted) return;
					const held = this.snapshot;
					if (!held) return;
					const existing = new Set(held.messages.map((message) => message.id));
					added = added.filter((message) => !existing.has(message.id));
					const combined = unique(direction === "older" ? [...added, ...held.messages] : [...held.messages, ...added]);
					const messages = fitHistoryWindow(combined, direction, this.viewport);
					if (!messages) {
						this.capacity = true;
						return;
					}
					if (direction === "older") {
						this.recoverOlder = false;
						if (messages.length !== combined.length) this.detached = true;
						this.snapshot = { ...(this.detached ? historyOnly(held) : held), messages, historyCursor: olderCursor };
						this.olderSeen.clear();
						this.olderProgress = new HistoryCursorProgress();
					} else {
						if (messages.length !== combined.length) this.recoverOlder = true;
						this.snapshot = {
							...held,
							messages,
							historyCursor: this.recoverOlder ? (held.historyCursor ?? fence.historyCursor) : held.historyCursor,
						};
						if (messages.at(-1)?.id === fence.messages.at(-1)?.id) {
							this.detached = false;
							this.snapshot = {
								...fence,
								messages,
								historyCursor: this.recoverOlder ? (held.historyCursor ?? fence.historyCursor) : held.historyCursor,
								runResults: mergeRunResults(
									held.runResults,
									current.runResults,
									previous?.runResults,
									fence.runResults,
								),
							};
							if (this.latest && this.latest !== fence) this.acceptLive(this.latest);
						}
					}
					this.replayDirection = undefined;
					if (added.length === 0) this.yieldDemand();
					return;
				}
				const cursor = current.nextCursor;
				if (!cursor || seen.has(cursor)) throw new AppError("INVALID_REQUEST");
				this.remember(seen, cursor);
				previous = current;
				current = await this.read(cursor, request.signal);
				this.validateScope(current);
				if (!progress.advance(cursor, current.nextCursor)) throw new AppError("INVALID_REQUEST");
				if (++scanned % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		} catch {
			if (!this.disposed && this.request === request) this.failed = true;
		} finally {
			clearTimeout(timeout);
			if (this.replayTimeout === timeout) this.replayTimeout = undefined;
			if (!this.disposed && this.request === request) {
				this.request = undefined;
				this.emit();
			}
		}
	}

	private emit() {
		if (!this.disposed) this.publish(this.state);
	}

	private remember(seen: Set<string>, cursor: string) {
		seen.add(cursor);
		if (seen.size > HISTORY_CAPACITY.pages) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
	}
}

function unique(messages: Message[]): Message[] {
	const seen = new Set<string>();
	return messages.filter((message) => {
		if (seen.has(message.id)) return false;
		seen.add(message.id);
		return true;
	});
}

function historyOnly(snapshot: Snapshot): Snapshot {
	return {
		...snapshot,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		partialId: undefined,
		running: false,
		execution: undefined,
	};
}
