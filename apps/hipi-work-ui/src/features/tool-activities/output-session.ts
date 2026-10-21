import {
	ACTIVITY_LIMITS,
	type AppClient,
	type Scope,
	TOOL_ACTIVITY_TEXT_PAGE_BYTES,
	type ToolActivity,
	type ToolActivityTextPage,
} from "@hipi/work-runtime/contracts";

export type ActivityOutputSlot = {
	page?: ToolActivityTextPage;
	cursor?: string;
	busy: boolean;
	failed: boolean;
};
type PendingRead = { activityId: string; cursor?: string };
/** Maximum serialized wire payload for one verified page, not a JavaScript heap estimate. */
export const ACTIVITY_OUTPUT_BYTES = ACTIVITY_LIMITS.page * TOOL_ACTIVITY_TEXT_PAGE_BYTES;

/** Subordinate retained-output lane. One FIFO read cannot block the parent's metadata/permission lane. */
export class ActivityOutputSession {
	private readonly client: AppClient;
	private readonly scope: Scope;
	private readonly changed: (slots: ReadonlyMap<string, ActivityOutputSlot>) => void;
	private slots = new Map<string, ActivityOutputSlot>();
	private published: ReadonlyMap<string, ActivityOutputSlot> = new Map();
	private members = new Set<string>();
	private leases = new Map<symbol, ReadonlySet<string>>();
	private queue: PendingRead[] = [];
	private retries = new Map<string, PendingRead>();
	private active = false;
	private validated = false;
	private generation = 0;
	private request: { controller: AbortController; read: PendingRead } | undefined;
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
				.slice(0, ACTIVITY_LIMITS.page)
				.filter((item) => item.textAvailable)
				.map((item) => item.activityId),
		);
		this.validated = true;
		this.reconcile();
	}
	lease(owner: symbol, ids: readonly string[]) {
		if (!this.leases.has(owner) && this.leases.size >= ACTIVITY_LIMITS.page * 4) return () => {};
		const lease = new Set(ids.slice(0, ACTIVITY_LIMITS.page));
		this.leases.set(owner, lease);
		this.reconcile();
		return () => {
			if (this.leases.get(owner) !== lease) return;
			this.leases.delete(owner);
			this.reconcile();
		};
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
			if (this.wanted(id) && !this.slots.has(id)) this.slots.set(id, { busy: false, failed: false });
		for (const [id, slot] of this.slots) if (!slot.page && !slot.busy && !slot.failed) this.enqueue({ activityId: id });
		this.publish();
		this.pump();
	}
	read(activityId: string, cursor?: string) {
		if (!this.active || !this.validated || !this.wanted(activityId) || this.slots.get(activityId)?.busy) return;
		this.enqueue({ activityId, ...(cursor === undefined ? {} : { cursor }) });
		this.publish();
		this.pump();
	}
	retry(activityId: string) {
		const read = this.retries.get(activityId);
		if (read) this.read(read.activityId, read.cursor);
	}
	private enqueue(read: PendingRead) {
		if (!this.validated || !this.active || this.queue.some((item) => item.activityId === read.activityId)) return;
		const slot = this.slots.get(read.activityId);
		if (!slot || slot.busy) return;
		this.slots.set(read.activityId, { ...slot, busy: true, failed: false });
		this.queue.push(read);
	}
	private pump() {
		if (!this.active || !this.validated || this.request) return;
		const read = this.queue.shift();
		if (!read) return;
		if (!this.wanted(read.activityId)) {
			this.pump();
			return;
		}
		const controller = new AbortController();
		const generation = this.generation;
		this.request = { controller, read };
		void this.load(read, controller, generation);
	}
	private async load(read: PendingRead, controller: AbortController, generation: number) {
		const timeout = setTimeout(() => controller.abort(), 15000);
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(new Error("Output read cancelled"));
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		try {
			const page = await Promise.race([
				this.client.call(
					"getToolActivityText",
					{ ...this.scope, activityId: read.activityId, ...(read.cursor === undefined ? {} : { cursor: read.cursor }) },
					controller.signal,
				),
				aborted,
			]);
			if (!this.active || generation !== this.generation || !this.wanted(read.activityId)) return;
			const textBytes = new TextEncoder().encode(page.text).byteLength;
			const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
			const retained = [...this.slots].reduce(
				(size, [id, slot]) =>
					size +
					(id === read.activityId ? 0 : slot.page ? new TextEncoder().encode(JSON.stringify(slot.page)).byteLength : 0),
				0,
			);
			if (
				controller.signal.aborted ||
				page.activityId !== read.activityId ||
				!page.retainedOutputOnly ||
				textBytes > ACTIVITY_LIMITS.textBytes
			)
				throw new Error("Invalid retained output");
			if (bytes > TOOL_ACTIVITY_TEXT_PAGE_BYTES || retained + bytes > ACTIVITY_OUTPUT_BYTES)
				throw new Error("Invalid output size");
			this.slots.set(read.activityId, { page, cursor: read.cursor, busy: false, failed: false });
			this.retries.delete(read.activityId);
		} catch {
			if (this.active && generation === this.generation && this.wanted(read.activityId)) {
				const slot = this.slots.get(read.activityId);
				if (slot) this.slots.set(read.activityId, { ...slot, busy: false, failed: true });
				this.retries.set(read.activityId, read);
			}
		} finally {
			clearTimeout(timeout);
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
	/** Keep last-readable chunks, but require a fresh verified metadata page before another read. */
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
		this.members.clear();
		this.slots.clear();
		this.retries.clear();
		this.publish();
	}
}
