import {
	ACTIVITY_LIMITS,
	type AppClient,
	type Scope,
	TOOL_ACTIVITY_TEXT_PAGE_BYTES,
	type ToolActivity,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";

export type ActivityOutputChunk = { index: number; cursor?: string; page: ToolActivityTextPage; bytes: number };
export type ActivityOutputSlot = {
	/** Most recently read page; aliases a chunk, never an additional retained payload. */
	page?: ToolActivityTextPage;
	cursor?: string;
	chunks?: readonly ActivityOutputChunk[];
	end?: number;
	busy: boolean;
	failed: boolean;
};
type PendingRead = { activityId: string; index: number; cursor?: string; target: number };
type Viewport = { activityId: string; indices: readonly number[]; selected: boolean; visible: boolean };
/** Wire payload ceiling, including the one in-flight page reservation, not a heap estimate. */
export const ACTIVITY_OUTPUT_BYTES = ACTIVITY_LIMITS.page * TOOL_ACTIVITY_TEXT_PAGE_BYTES;
export const OUTPUT_WINDOW_CHUNKS = 3;
/** Shared across all slots: at most 65,536 cursor code units, excluding bounded map bookkeeping. */
export const OUTPUT_CURSOR_CHECKPOINTS = 32;
export const OUTPUT_METADATA_MEMBERS = ACTIVITY_LIMITS.page * 3;

/** One bounded, shared FIFO. Scroll demand reads retained evidence; it never executes a tool. */
export class ActivityOutputSession {
	private readonly client: AppClient;
	private readonly scope: Scope;
	private readonly changed: (slots: ReadonlyMap<string, ActivityOutputSlot>) => void;
	private slots = new Map<string, ActivityOutputSlot>();
	private published: ReadonlyMap<string, ActivityOutputSlot> = new Map();
	private members = new Set<string>();
	private leases = new Map<symbol, ReadonlySet<string>>();
	private viewports = new Map<symbol, Viewport>();
	private checkpoints = new Map<string, Map<number, string | undefined>>();
	private furthest = new Map<string, number>();
	private queue: PendingRead[] = [];
	private retries = new Map<string, PendingRead>();
	private active = false;
	private validated = false;
	private generation = 0;
	private request: { controller: AbortController; read: PendingRead } | undefined;
	private held: { controller: AbortController; release: () => void } | undefined;
	constructor(client: AppClient, scope: Scope, changed: (slots: ReadonlyMap<string, ActivityOutputSlot>) => void) {
		this.client = client;
		this.scope = { ...scope };
		this.changed = changed;
	}
	snapshot = () => this.published;
	activate() {
		this.active = true;
		this.reconcile();
	}
	validate(items: readonly ToolActivity[]) {
		this.members = new Set(
			items
				.slice(0, OUTPUT_METADATA_MEMBERS)
				.filter((item) => item.textAvailable)
				.map((item) => item.activityId),
		);
		this.validated = true;
		for (const id of this.checkpoints.keys()) if (!this.members.has(id)) this.checkpoints.delete(id);
		for (const id of this.furthest.keys()) if (!this.members.has(id)) this.furthest.delete(id);
		this.reconcile();
	}
	lease(owner: symbol, ids: readonly string[]) {
		if (!this.leases.has(owner) && this.leases.size >= ACTIVITY_LIMITS.page * 4) return () => {};
		const lease = new Set(ids.slice(0, ACTIVITY_LIMITS.page));
		this.leases.set(owner, lease);
		this.reconcile();
		return () => {
			if (this.leases.get(owner) !== lease) return;
			this.release(owner);
		};
	}
	release(owner: symbol) {
		this.leases.delete(owner);
		this.reconcile();
	}
	/** Pins are local to each visible reader; an inline view and its dialog can read different positions. */
	viewport(owner: symbol, viewport?: Viewport) {
		if (viewport) {
			if (!this.viewports.has(owner) && this.viewports.size >= ACTIVITY_LIMITS.page * 4) return;
			this.viewports.set(owner, { ...viewport, indices: viewport.indices.slice(0, OUTPUT_WINDOW_CHUNKS) });
		} else this.viewports.delete(owner);
		const current = this.request;
		if (current && !this.readable(current.read.activityId)) {
			this.abort();
			this.enqueue(current.read);
			this.publish();
		}
		if (!this.selected()) this.held?.release();
		this.pump();
	}
	private selected() {
		return [...this.viewports.values()].some((view) => view.selected);
	}
	private readable(id: string) {
		const views = [...this.viewports.values()].filter((view) => view.activityId === id);
		return !views.length || views.some((view) => view.visible);
	}
	private pinned(id: string, index: number) {
		return [...this.viewports.values()].some(
			(view) => view.activityId === id && (view.visible || view.selected) && view.indices.includes(index),
		);
	}
	private wanted(id: string) {
		return this.members.has(id) && [...this.leases.values()].some((ids) => ids.has(id));
	}
	private publish() {
		this.published = new Map(this.slots);
		this.changed(this.published);
	}
	private reconcile() {
		if (!this.active) return;
		for (const id of this.slots.keys())
			if (!this.wanted(id)) {
				if (this.request?.read.activityId === id) this.abort();
				this.slots.delete(id);
				this.retries.delete(id);
			}
		this.queue = this.queue.filter((read) => this.wanted(read.activityId));
		for (const id of this.members)
			if (this.wanted(id) && !this.slots.has(id) && this.slots.size < ACTIVITY_LIMITS.page)
				this.slots.set(id, { chunks: [], busy: false, failed: false });
		for (const [id, slot] of this.slots)
			if (!slot.chunks?.length && !slot.busy && !slot.failed) this.enqueue({ activityId: id, index: 0, target: 0 });
		this.publish();
		this.pump();
	}
	/** Cursor entry retained for nonvisual consumers; unknown cursors are not accepted. */
	read(activityId: string, cursor?: string) {
		let index = cursor === undefined ? 0 : undefined;
		for (const [position, known] of this.checkpoints.get(activityId) ?? []) if (cursor === known) index = position;
		if (index !== undefined) this.reveal(activityId, index);
	}
	/** Reveal one adjacent/previously visited chunk. No prefetch loop is started by a successful read. */
	reveal(activityId: string, target: number) {
		const slot = this.slots.get(activityId);
		if (
			!this.active ||
			!this.validated ||
			!this.wanted(activityId) ||
			!slot ||
			slot.busy ||
			slot.failed ||
			!Number.isSafeInteger(target) ||
			target < 0 ||
			(slot.end !== undefined && target > slot.end)
		)
			return;
		if (slot.chunks?.some((chunk) => chunk.index === target)) return;
		const known = this.checkpoints.get(activityId);
		const furthest = Math.max(
			this.furthest.get(activityId) ?? 0,
			...[...(known?.keys() ?? [])],
			...(slot.chunks ?? []).map((chunk) => chunk.index + (chunk.page.nextCursor ? 1 : 0)),
		);
		if (target > furthest) return;
		let index = 0;
		let cursor: string | undefined;
		for (const [position, value] of known ?? [])
			if (position <= target && position >= index) {
				index = position;
				cursor = value;
			}
		for (const chunk of slot.chunks ?? []) {
			if (chunk.index <= target && chunk.index >= index) {
				index = chunk.index;
				cursor = chunk.cursor;
			}
			if (chunk.page.nextCursor && chunk.index + 1 <= target && chunk.index + 1 >= index) {
				index = chunk.index + 1;
				cursor = chunk.page.nextCursor;
			}
		}
		this.enqueue({ activityId, index, cursor, target });
		this.publish();
		this.pump();
	}
	retry(activityId: string) {
		const read = this.retries.get(activityId);
		if (!read || !this.active || !this.validated || !this.wanted(activityId)) return;
		this.enqueue(read);
		this.publish();
		this.pump();
	}
	private enqueue(read: PendingRead) {
		if (!this.validated || !this.active || this.queue.some((item) => item.activityId === read.activityId)) return;
		const slot = this.slots.get(read.activityId);
		if (!slot || slot.busy) return;
		this.slots.set(read.activityId, { ...slot, busy: true, failed: false });
		this.queue.push(read);
	}
	private drop(id: string, index: number) {
		const slot = this.slots.get(id);
		if (!slot) return;
		const chunks = (slot.chunks ?? []).filter((chunk) => chunk.index !== index);
		const page = chunks.find((chunk) => chunk.page === slot.page) ?? chunks.at(-1);
		this.slots.set(id, { ...slot, chunks, page: page?.page, cursor: page?.cursor });
	}
	private reserve(read: PendingRead) {
		const evictions: { id: string; chunk: ActivityOutputChunk }[] = [];
		const same = this.slots.get(read.activityId)?.chunks ?? [];
		if (same.length >= OUTPUT_WINDOW_CHUNKS) {
			const removable = same
				.filter((chunk) => !this.pinned(read.activityId, chunk.index))
				.sort((a, b) => Math.abs(b.index - read.target) - Math.abs(a.index - read.target))[0];
			if (!removable) return false;
			evictions.push({ id: read.activityId, chunk: removable });
		}
		const chunks = [...this.slots].flatMap(([id, slot]) => (slot.chunks ?? []).map((chunk) => ({ id, chunk })));
		let bytes =
			chunks.reduce((sum, { chunk }) => sum + chunk.bytes, 0) -
			evictions.reduce((sum, { chunk }) => sum + chunk.bytes, 0);
		for (const { id, chunk } of chunks) {
			if (bytes + TOOL_ACTIVITY_TEXT_PAGE_BYTES <= ACTIVITY_OUTPUT_BYTES) break;
			if (
				this.pinned(id, chunk.index) ||
				evictions.some((entry) => entry.id === id && entry.chunk.index === chunk.index)
			)
				continue;
			evictions.push({ id, chunk });
			bytes -= chunk.bytes;
		}
		if (bytes + TOOL_ACTIVITY_TEXT_PAGE_BYTES > ACTIVITY_OUTPUT_BYTES) return false;
		for (const { id, chunk } of evictions) this.drop(id, chunk.index);
		return true;
	}
	private pump() {
		if (!this.active || !this.validated || this.request || this.selected()) return;
		const position = this.queue.findIndex(
			(read) => this.wanted(read.activityId) && this.readable(read.activityId) && this.reserve(read),
		);
		if (position < 0) return;
		const read = this.queue[position];
		if (!read) return;
		this.queue.splice(position, 1);
		const controller = new AbortController();
		const generation = this.generation;
		this.request = { controller, read };
		this.publish();
		void this.load(read, controller, generation);
	}
	private async load(initial: PendingRead, controller: AbortController, generation: number) {
		let timeout = setTimeout(() => controller.abort(), 15000);
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(new Error("Output read cancelled"));
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		let read = initial;
		try {
			// Rebuild an evicted cursor only in response to backward scroll demand. Payloads are discarded
			// while seeking; only 32 cursor checkpoints and one in-flight response are retained.
			while (true) {
				const page = await Promise.race([
					this.client.call(
						"getToolActivityText",
						{
							...this.scope,
							activityId: read.activityId,
							...(read.cursor === undefined ? {} : { cursor: read.cursor }),
						},
						controller.signal,
					),
					aborted,
				]);
				if (!this.active || generation !== this.generation || !this.wanted(read.activityId)) return;
				const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
				if (
					controller.signal.aborted ||
					page.activityId !== read.activityId ||
					!page.retainedOutputOnly ||
					new TextEncoder().encode(page.text).byteLength > ACTIVITY_LIMITS.textBytes ||
					bytes > TOOL_ACTIVITY_TEXT_PAGE_BYTES ||
					page.nextCursor === read.cursor ||
					(page.nextCursor?.length ?? 0) > 2048
				)
					throw new Error("Invalid retained output");
				if (this.selected()) {
					// The reserved, validated in-flight response is held, not republished under a selection.
					// Reading stops here without throwing away a successfully received retained page.
					clearTimeout(timeout);
					await Promise.race([
						new Promise<void>((release) => {
							this.held = { controller, release };
						}),
						aborted,
					]);
					if (this.held?.controller === controller) this.held = undefined;
					if (!this.active || generation !== this.generation || !this.wanted(read.activityId)) return;
					timeout = setTimeout(() => controller.abort(), 15000);
				}
				const checkpoints = this.checkpoints.get(read.activityId) ?? new Map<number, string | undefined>();
				if (checkpoints.has(read.index + 1) && checkpoints.get(read.index + 1) !== page.nextCursor)
					throw new Error("Retained output changed during restoration");
				if (
					page.nextCursor &&
					[...checkpoints].some(([index, cursor]) => index <= read.index && cursor === page.nextCursor)
				)
					throw new Error("Repeated retained output cursor");
				checkpoints.set(read.index, read.cursor);
				if (page.nextCursor) checkpoints.set(read.index + 1, page.nextCursor);
				this.checkpoints.delete(read.activityId);
				this.checkpoints.set(read.activityId, checkpoints);
				while (
					[...this.checkpoints.values()].reduce((sum, entries) => sum + entries.size, 0) > OUTPUT_CURSOR_CHECKPOINTS
				) {
					const oldest = this.checkpoints.entries().next().value;
					if (!oldest) break;
					const first = oldest[1].keys().next().value;
					if (first !== undefined) oldest[1].delete(first);
					if (!oldest[1].size) this.checkpoints.delete(oldest[0]);
				}
				this.furthest.set(
					read.activityId,
					Math.max(this.furthest.get(read.activityId) ?? 0, read.index + (page.nextCursor ? 1 : 0)),
				);
				if (read.index < read.target) {
					if (!page.nextCursor) throw new Error("Retained output changed during restoration");
					read = { ...read, index: read.index + 1, cursor: page.nextCursor };
					continue;
				}
				const slot = this.slots.get(read.activityId);
				if (!slot) return;
				const chunks = [
					...(slot.chunks ?? []).filter((chunk) => chunk.index !== read.index),
					{ index: read.index, cursor: read.cursor, page, bytes },
				].sort((a, b) => a.index - b.index);
				this.slots.set(read.activityId, {
					page,
					cursor: read.cursor,
					chunks,
					end: page.nextCursor ? slot.end : read.index,
					busy: false,
					failed: false,
				});
				this.retries.delete(read.activityId);
				break;
			}
		} catch {
			if (this.active && generation === this.generation && this.wanted(read.activityId)) {
				const slot = this.slots.get(read.activityId);
				if (slot) this.slots.set(read.activityId, { ...slot, busy: false, failed: true });
				this.retries.set(read.activityId, read);
			}
		} finally {
			clearTimeout(timeout);
			if (this.held?.controller === controller) this.held = undefined;
			controller.signal.removeEventListener("abort", rejectAbort);
			if (generation === this.generation && this.request?.controller === controller) {
				this.request = undefined;
				this.publish();
				this.pump();
			}
		}
	}
	private abort() {
		this.generation++;
		const current = this.request;
		this.request = undefined;
		current?.controller.abort();
		if (current) {
			const slot = this.slots.get(current.read.activityId);
			if (slot) this.slots.set(current.read.activityId, { ...slot, busy: false });
		}
	}
	/** Keep last-readable chunks; a fresh verified metadata page is required before another read. */
	pause() {
		this.validated = false;
		this.abort();
		this.queue = [];
		for (const [id, slot] of this.slots) if (slot.busy) this.slots.set(id, { ...slot, busy: false });
		this.publish();
	}
	dispose() {
		this.active = false;
		this.pause();
		this.leases.clear();
		this.viewports.clear();
		this.checkpoints.clear();
		this.furthest.clear();
		this.members.clear();
		this.slots.clear();
		this.retries.clear();
		this.publish();
	}
}
