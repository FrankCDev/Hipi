import { AppError, LIMITS, type MessageTextChunk } from "@hipi/work-runtime/contracts";

/** Engineering payload budget, not a reference-client limit or a process/DOM memory bound. */
export const DOCUMENT_SOURCE_BUDGET_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_READ_CONCURRENCY = 2;
const UTF16_BYTES = 2;
// Reserve current and prior displayed projection. A selected projection may not
// be replaced; its owner is paused until that selection is released.
const PROJECTION_COPIES = 2;
export type DocumentSnapshot = {
	source: string;
	loadedUnits: number;
	complete: boolean;
	loading: boolean;
	failed: boolean;
	pressure: boolean;
	limited: boolean;
};
type Read = (offset: number, signal: AbortSignal) => Promise<MessageTextChunk>;
type Entry = {
	key: string;
	length: number;
	read: Read;
	value: DocumentSnapshot;
	canonical: string;
	leases: Map<symbol, { active: boolean; selected: boolean }>;
	listeners: Set<() => void>;
	request?: AbortController;
	reserved: number;
	touched: number;
};

/** Scope-keyed source ownership and fair, single-chunk scheduling across visible messages. */
export class MessageDocumentPool {
	private entries = new Map<string, Entry>();
	private flights = 0;
	private clock = 0;
	private scheduling = false;
	constructor(
		private readonly budget = DOCUMENT_SOURCE_BUDGET_BYTES,
		private readonly concurrency = DOCUMENT_READ_CONCURRENCY,
	) {}

	get retainedBytes() {
		let bytes = 0;
		for (const entry of this.entries.values()) bytes += this.cost(entry.value.source.length) + entry.reserved;
		return bytes;
	}
	private cost(units: number) {
		return units * UTF16_BYTES * PROJECTION_COPIES;
	}
	private publish(entry: Entry, patch: Partial<DocumentSnapshot>) {
		entry.value = { ...entry.value, ...patch };
		for (const listener of entry.listeners) listener();
	}
	private makeRoom(bytes: number, protectedEntry?: Entry) {
		for (const entry of [...this.entries.values()].sort((a, b) => a.touched - b.touched)) {
			if (this.retainedBytes + bytes <= this.budget) break;
			if (entry !== protectedEntry && entry.leases.size === 0 && !entry.request) this.entries.delete(entry.key);
		}
		return this.retainedBytes + bytes <= this.budget;
	}

	acquire(key: string, length: number, read: Read, initialSource = "") {
		let entry = this.entries.get(key);
		if (!entry) {
			const admitted = this.makeRoom(this.cost(initialSource.length));
			entry = {
				key,
				length,
				read,
				canonical: "",
				value: {
					source: admitted ? initialSource : "",
					loadedUnits: 0,
					complete: false,
					loading: false,
					failed: false,
					pressure: !admitted,
					limited: this.cost(initialSource.length) > this.budget,
				},
				leases: new Map(),
				listeners: new Set(),
				reserved: 0,
				touched: ++this.clock,
			};
			this.entries.set(key, entry);
		}
		const owner = entry;
		const lease = Symbol(key);
		owner.leases.set(lease, { active: false, selected: false });
		owner.touched = ++this.clock;
		let released = false;
		return {
			getSnapshot: () => owner.value,
			subscribe: (listener: () => void) => {
				owner.listeners.add(listener);
				return () => {
					owner.listeners.delete(listener);
				};
			},
			setActive: (active: boolean, abortPending = true) => {
				if (released) return;
				owner.leases.set(lease, { active, selected: !active && !abortPending });
				if (abortPending && ![...owner.leases.values()].some((state) => state.active)) this.cancel(owner);
				this.pump();
			},
			retry: () => {
				if (!released) {
					this.publish(owner, { failed: false });
					this.pump();
				}
			},
			release: () => {
				if (released) return;
				released = true;
				owner.leases.delete(lease);
				owner.touched = ++this.clock;
				if (![...owner.leases.values()].some((state) => state.active)) this.cancel(owner);
				this.pump();
			},
		};
	}

	private cancel(entry: Entry) {
		if (entry.request) {
			entry.request.abort();
			entry.request = undefined;
			entry.reserved = 0;
			this.flights--;
		}
		if (entry.value.loading) this.publish(entry, { loading: false });
	}
	private pump() {
		if (this.scheduling) return;
		this.scheduling = true;
		try {
			for (const entry of [...this.entries.values()].sort((a, b) => a.touched - b.touched)) {
				if (this.flights >= this.concurrency) break;
				if (
					entry.request ||
					entry.value.failed ||
					entry.value.complete ||
					![...entry.leases.values()].some((state) => state.active) ||
					[...entry.leases.values()].some((state) => state.selected)
				)
					continue;
				const units = Math.min(LIMITS.textChunk, entry.length - entry.value.loadedUnits);
				const reserve = this.cost(Math.max(0, units));
				if (!this.makeRoom(reserve, entry)) {
					const limited = this.cost(entry.value.source.length) + reserve > this.budget;
					if (!entry.value.pressure || entry.value.limited !== limited)
						this.publish(entry, { pressure: true, limited, loading: false });
					continue;
				}
				entry.reserved = reserve;
				entry.touched = ++this.clock;
				const controller = new AbortController();
				entry.request = controller;
				this.flights++;
				this.publish(entry, { loading: true, pressure: false, limited: false });
				void this.load(entry, controller);
			}
		} finally {
			this.scheduling = false;
		}
	}
	private async load(entry: Entry, controller: AbortController) {
		try {
			const offset = entry.value.loadedUnits;
			const page = await entry.read(offset, controller.signal);
			if (controller.signal.aborted) return;
			const overlap = offset - page.offset;
			if (
				overlap < 0 ||
				overlap > 1 ||
				(overlap === 1 &&
					(entry.canonical.slice(offset - 1, offset) !== page.text.slice(0, 1) ||
						page.text.charCodeAt(0) < 0xd800 ||
						page.text.charCodeAt(0) > 0xdbff ||
						page.text.charCodeAt(1) < 0xdc00 ||
						page.text.charCodeAt(1) > 0xdfff))
			)
				throw new AppError("INVALID_REQUEST");
			if (page.text.length > LIMITS.textChunk || page.textLength !== entry.length)
				throw new AppError("INVALID_REQUEST");
			const prefix = entry.canonical;
			const canonical = prefix + page.text.slice(overlap);
			const complete = page.nextOffset === null;
			if (
				canonical.length > entry.length ||
				(complete && canonical.length !== entry.length) ||
				(!complete && page.nextOffset !== canonical.length) ||
				(!complete && canonical.length <= offset)
			)
				throw new AppError("INVALID_REQUEST");
			// Keep the matching live projection until canonical reads catch up. It
			// is never offered as complete copy/search data before verification.
			const source = complete || canonical.length >= entry.value.source.length ? canonical : entry.value.source;
			const added = this.cost(source.length - entry.value.source.length);
			if (added > entry.reserved) throw new AppError("INVALID_REQUEST");
			entry.canonical = canonical;
			entry.reserved = 0;
			this.publish(entry, { source, loadedUnits: canonical.length, complete, loading: false });
		} catch {
			if (!controller.signal.aborted) this.publish(entry, { failed: true, loading: false });
		} finally {
			if (entry.request === controller) {
				entry.request = undefined;
				entry.reserved = 0;
				this.flights--;
				this.pump();
			}
		}
	}
}
