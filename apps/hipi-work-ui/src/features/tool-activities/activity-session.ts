import type {
	AppClient,
	Scope,
	ToolActivityPage,
	ToolActivitySelector,
	ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";
import { validateActivitySelection } from "./activity-selection.ts";
import { ActivityOutputSession, type ActivityOutputSlot } from "./output-session.ts";

export type ActivityState = {
	window?: readonly ActivityMetadataWindow[];
	windowTarget?: number;
	outputs?: ReadonlyMap<string, ActivityOutputSlot>;
	page?: ToolActivityPage;
	cursor?: string;
	text?: ToolActivityTextPage;
	/** Request cursor that produced text; undefined denotes its first chunk. */
	textCursor?: string;
	expanded?: string;
	busy: boolean;
	failed: boolean;
};
export type ActivityMetadataWindow = { index: number; cursor?: string; page: ToolActivityPage };
type Read =
	| { kind: "page"; cursor?: string; inline?: boolean; windowIndex?: number; target?: number; resetWindow?: boolean }
	| { kind: "text"; activityId: string; cursor?: string };
// One visible expansion may skip empty storage scan windows, never unbounded history.
export const INLINE_ACTIVITY_SCAN_PAGES = 8;

/** Bounded metadata windows and subordinate leased output slots share one scope owner. */
export class ActivitySession {
	private state: ActivityState = { busy: false, failed: false };
	private listeners = new Set<() => void>();
	private request?: AbortController;
	private generation = 0;
	private active = false;
	private retryRead?: Read;
	private client: AppClient;
	private scope: Scope;
	private selector?: ToolActivitySelector;
	private expectedCalls?: ReadonlyMap<string, string>;
	private checkpoints = new Map<number, string | undefined>();
	private continuationCursors = new Set<string>();
	private metadataSelected = false;
	private selectionWaiters = new Set<() => void>();
	readonly outputs: ActivityOutputSession;
	constructor(
		client: AppClient,
		scope: Scope,
		selector?: ToolActivitySelector,
		expectedCalls?: ReadonlyMap<string, string>,
	) {
		this.client = client;
		this.selector = selector ? structuredClone(selector) : undefined;
		this.expectedCalls = expectedCalls ? new Map(expectedCalls) : undefined;
		this.scope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
		this.outputs = new ActivityOutputSession(client, this.scope, (outputs) => this.publish({ ...this.state, outputs }));
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	activate() {
		this.active = true;
		this.outputs.activate();
	}
	selectMetadata(selected: boolean) {
		this.metadataSelected = selected;
		if (!selected) {
			for (const release of this.selectionWaiters) release();
			this.selectionWaiters.clear();
		}
	}
	private checkpoint(index: number, cursor: string | undefined) {
		this.checkpoints.set(index, cursor);
		while (this.checkpoints.size > 128) {
			const first = this.checkpoints.keys().next().value;
			if (first !== undefined) this.checkpoints.delete(first);
		}
	}
	private publish(state: ActivityState) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	cancel() {
		this.outputs.pause();
		this.generation++;
		this.request?.abort();
		this.request = undefined;
		this.publish({ ...this.state, busy: false });
	}
	collapse() {
		this.cancel();
		const pageFailed = this.state.failed && this.retryRead?.kind === "page";
		if (!pageFailed) this.retryRead = undefined;
		this.publish({ ...this.state, text: undefined, textCursor: undefined, expanded: undefined, failed: pageFailed });
	}
	dispose() {
		this.active = false;
		this.cancel();
		this.retryRead = undefined;
		this.checkpoints.clear();
		this.continuationCursors.clear();
		this.selectMetadata(false);
		this.outputs.dispose();
		this.publish({ busy: false, failed: false });
	}
	page(cursor?: string) {
		if (this.selector?.kind === "tasks" && cursor !== undefined) return Promise.resolve();
		return this.read({ kind: "page", cursor });
	}
	inlinePage(cursor?: string) {
		if (this.selector?.kind === "tasks" && cursor !== undefined) return Promise.resolve();
		return this.read({ kind: "page", cursor, inline: true });
	}
	/** A bounded three-page view. Missing old cursors are replayed, never guessed. */
	windowPage(index: number) {
		if (this.selector?.kind === "tasks" || index < 0 || !Number.isSafeInteger(index)) return Promise.resolve();
		if (index === 0 && !this.state.window && this.state.page && this.state.cursor === undefined) {
			this.publish({ ...this.state, window: [{ index: 0, page: this.state.page }] });
			if (this.state.page?.nextCursor) this.checkpoint(1, this.state.page.nextCursor);
			return Promise.resolve();
		}
		let start = 0;
		let cursor: string | undefined;
		for (const [position, checkpoint] of this.checkpoints)
			if (position <= index && position >= start) {
				start = position;
				cursor = checkpoint;
			}
		return this.read({ kind: "page", inline: true, cursor, windowIndex: start, target: index });
	}
	continueWindow() {
		return this.retryRead?.kind === "page" && this.retryRead.windowIndex !== undefined
			? this.read(this.retryRead)
			: Promise.resolve();
	}
	text(activityId: string, cursor?: string) {
		if (!this.state.page?.items.some((item) => item.activityId === activityId && item.textAvailable))
			return Promise.resolve();
		return this.read({ kind: "text", activityId, cursor });
	}
	retry() {
		return this.retryRead ? this.read(this.retryRead) : Promise.resolve();
	}
	private async read(read: Read) {
		if (!this.active || this.request) return;
		const controller = new AbortController();
		this.request = controller;
		const generation = ++this.generation;
		this.retryRead = read;
		this.publish({
			...this.state,
			busy: true,
			failed: false,
			...(read.kind === "text"
				? {
						expanded: read.activityId,
						text: this.state.text?.activityId === read.activityId ? this.state.text : undefined,
						textCursor: this.state.text?.activityId === read.activityId ? this.state.textCursor : undefined,
					}
				: {}),
		});
		// Cancelling this wait never cancels tool execution or implies rollback.
		let timeout = setTimeout(() => controller.abort(), 15000);
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(new Error("Read cancelled"));
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		try {
			// Desktop validates before serialization; absent optional fields must not be own undefined keys.
			const cursor = read.cursor === undefined ? {} : { cursor: read.cursor };
			if (read.kind === "page") {
				if (read.cursor === undefined) this.continuationCursors.clear();
				let position = read.cursor;
				let windowIndex = read.windowIndex;
				let windowCursor = position;
				let page: ToolActivityPage;
				const seen = new Set<string>();
				let scanned = 0;
				do {
					if (position !== undefined) {
						if (seen.has(position)) throw new Error("Repeated activity cursor");
						seen.add(position);
					}
					this.retryRead = { ...read, cursor: position, windowIndex };
					page = await Promise.race([
						this.client.call(
							"getToolActivities",
							{
								...this.scope,
								...(position === undefined ? {} : { cursor: position }),
								...(this.selector ? { selector: this.selector } : {}),
							},
							controller.signal,
						),
						aborted,
					]);
					if (!this.active || generation !== this.generation) return;
					if (controller.signal.aborted) throw new Error("Read timed out");
					validateActivitySelection(page, this.selector, this.expectedCalls);
					if (windowIndex !== undefined && this.metadataSelected) {
						// One received page may wait behind a selection; it cannot evict selected evidence or start another read.
						clearTimeout(timeout);
						let release: () => void = () => {};
						const selected = new Promise<void>((resolve) => {
							release = resolve;
							this.selectionWaiters.add(release);
						});
						try {
							await Promise.race([selected, aborted]);
						} finally {
							this.selectionWaiters.delete(release);
						}
						if (!this.active || generation !== this.generation) return;
						timeout = setTimeout(() => controller.abort(), 15000);
					}
					if (page.nextCursor && seen.has(page.nextCursor)) throw new Error("Repeated activity cursor");
					if (
						windowIndex !== undefined &&
						page.nextCursor &&
						[...this.checkpoints].some(([index, cursor]) => index <= (windowIndex ?? -1) && cursor === page.nextCursor)
					)
						throw new Error("Repeated activity cursor");
					if (read.inline && windowIndex === undefined && this.selector?.kind === "message") {
						if (position) this.continuationCursors.add(position);
						if (page.nextCursor && this.continuationCursors.has(page.nextCursor))
							throw new Error("Repeated activity cursor");
						while (this.continuationCursors.size > 128) {
							const first = this.continuationCursors.values().next().value;
							if (first) this.continuationCursors.delete(first);
						}
					}
					scanned++;
					if (windowIndex !== undefined && page.items.length && windowIndex < (read.target ?? 0) && page.nextCursor) {
						windowIndex++;
						windowCursor = page.nextCursor;
						this.checkpoint(windowIndex, windowCursor);
						position = page.nextCursor;
						continue;
					}
					if (!read.inline || page.items.length || !page.nextCursor || scanned >= INLINE_ACTIVITY_SCAN_PAGES) break;
					position = page.nextCursor;
				} while (scanned < INLINE_ACTIVITY_SCAN_PAGES);
				if (windowIndex !== undefined) {
					const complete = (windowIndex === read.target && page.items.length > 0) || !page.nextCursor;
					if (complete) {
						const prior = (read.resetWindow ? [] : (this.state.window ?? [])).filter(
							(entry) => Math.abs(entry.index - windowIndex) <= 2,
						);
						if (prior.length && prior[0]?.page.membershipFence !== page.membershipFence)
							throw new Error("Activity membership changed");
						const next = [
							...prior.filter((entry) => entry.index !== windowIndex),
							{ index: windowIndex, cursor: windowCursor, page },
						].sort((a, b) => a.index - b.index);
						while (next.length > 3) {
							if (windowIndex === next[0]?.index) next.pop();
							else next.shift();
						}
						this.checkpoint(windowIndex, windowCursor);
						if (page.nextCursor) this.checkpoint(windowIndex + 1, page.nextCursor);
						this.publish({
							...this.state,
							page,
							cursor: position,
							window: next,
							windowTarget: undefined,
							busy: false,
							failed: false,
						});
						this.outputs.validate(next.flatMap((entry) => entry.page.items));
					} else {
						this.retryRead = { ...read, windowIndex, cursor: page.nextCursor ?? position };
						this.publish({
							...this.state,
							cursor: page.nextCursor ?? position,
							windowTarget: read.target,
							busy: false,
							failed: false,
						});
						return;
					}
				} else {
					if (read.inline && this.selector?.kind === "message" && read.cursor && this.state.page) {
						if (this.state.page.membershipFence !== page.membershipFence)
							throw new Error("Activity membership changed");
						const items = new Map(this.state.page.items.map((item) => [item.activityId, item]));
						for (const item of page.items) {
							const previous = items.get(item.activityId);
							if (previous && JSON.stringify(previous.anchor) !== JSON.stringify(item.anchor))
								throw new Error("Activity occurrence changed");
							items.set(item.activityId, item);
						}
						if (items.size > 16) throw new Error("Message activity capacity exceeded");
						page = { ...page, items: [...items.values()] };
					}
					this.publish({ page, cursor: position, busy: false, failed: false, outputs: this.outputs.snapshot() });
					this.outputs.validate(page.items);
				}
			} else {
				const text = await Promise.race([
					this.client.call(
						"getToolActivityText",
						{ ...this.scope, activityId: read.activityId, ...cursor },
						controller.signal,
					),
					aborted,
				]);
				if (!this.active || generation !== this.generation) return;
				if (controller.signal.aborted || text.activityId !== read.activityId || !text.retainedOutputOnly)
					throw new Error("Invalid retained output");
				this.publish({ ...this.state, text, textCursor: read.cursor, busy: false, failed: false });
			}
			this.retryRead = undefined;
		} catch (error) {
			if (error instanceof Error && error.message === "Activity membership changed") {
				this.checkpoints.clear();
				this.retryRead =
					read.kind === "page" && read.windowIndex !== undefined
						? { kind: "page", inline: true, windowIndex: 0, target: 0, resetWindow: true }
						: { kind: "page", inline: true };
			}
			if (this.active && generation === this.generation) this.publish({ ...this.state, busy: false, failed: true });
		} finally {
			clearTimeout(timeout);
			controller.signal.removeEventListener("abort", rejectAbort);
			if (generation === this.generation) this.request = undefined;
		}
	}
}
