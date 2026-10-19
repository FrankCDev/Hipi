import {
	AppError,
	type HistoryPage,
	LIMITS,
	type Message,
	type Scope,
	type Snapshot,
} from "@hipi/work-runtime/contracts";

// Provisional cache capacities, not measured performance guarantees. Never evict read messages.
export const HISTORY_CAPACITY = { messages: 2048, textUnits: 4 * 1024 * 1024, pages: 2048 } as const;
export type ConversationHistoryState = {
	snapshot?: Snapshot;
	loading: boolean;
	failed: boolean;
	reconciling: boolean;
	capacity: boolean;
	blocked: "capacity" | "scan-limit" | null;
};
type Bridge = { snapshot: Snapshot; messages: Message[]; cursor: string | null; seen: Set<string> };

/** One mounted scope owns previews, its original older fence, and at most one cancellable read.
 * Live gaps are staged separately until the retained tail is found. Capacity stops growth rather
 * than discarding messages the user may be reading. Disposal releases the complete cache.
 */
export class ConversationHistoryController {
	private readonly scope: Scope;
	private readonly read: (cursor: string, signal: AbortSignal) => Promise<HistoryPage>;
	private readonly publish: (state: ConversationHistoryState) => void;
	private snapshot: Snapshot | undefined;
	private latest: Snapshot | undefined;
	private scanPages = 0;
	private scanLimited = false;
	private bridge: Bridge | undefined;
	private queued: Snapshot | undefined;
	private request: AbortController | undefined;
	private readonly olderSeen = new Set<string>();
	private pages = 0;
	private nearTop = false;
	private failed = false;
	private capacity = false;
	private disposed = false;

	constructor(
		scope: Scope,
		read: (cursor: string, signal: AbortSignal) => Promise<HistoryPage>,
		publish: (state: ConversationHistoryState) => void,
	) {
		this.scope = { ...scope };
		this.read = read;
		this.publish = publish;
	}

	get state(): ConversationHistoryState {
		return {
			snapshot: this.snapshot,
			loading: this.request !== undefined,
			failed: this.failed,
			reconciling: this.bridge !== undefined || this.queued !== undefined,
			capacity: this.capacity,
			blocked: this.capacity ? "capacity" : this.scanLimited ? "scan-limit" : null,
		};
	}

	update(snapshot: Snapshot) {
		if (this.disposed) return;
		this.validateScope(snapshot);
		this.latest = snapshot;
		if (this.capacity) return;
		if (!this.fits(this.snapshot?.messages ?? [], this.bridge?.messages ?? [], snapshot.messages)) {
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
		this.pump();
	}

	retry() {
		if (this.disposed || (!this.failed && !this.scanLimited) || this.capacity) return;
		this.failed = false;
		this.scanLimited = false;
		this.scanPages = 0;
		this.emit();
		// An explicit retry also retries an older page after the user has scrolled away.
		this.pump(true);
	}

	resetToLatest() {
		if (this.disposed) return;
		this.request?.abort();
		this.request = undefined;
		this.snapshot = this.latest ? { ...this.latest, messages: unique(this.latest.messages) } : undefined;
		this.bridge = undefined;
		this.queued = undefined;
		this.olderSeen.clear();
		this.pages = 0;
		this.scanPages = 0;
		this.scanLimited = false;
		this.failed = false;
		this.capacity = false;
		this.nearTop = false;
		this.emit();
	}

	dispose() {
		this.disposed = true;
		this.request?.abort();
		this.request = undefined;
		this.snapshot = undefined;
		this.latest = undefined;
		this.bridge = undefined;
		this.queued = undefined;
		this.olderSeen.clear();
	}

	private validateScope(value: Scope) {
		if (value.workspaceId !== this.scope.workspaceId || value.conversationId !== this.scope.conversationId)
			throw new AppError("INVALID_REQUEST");
	}

	private fits(...groups: Message[][]): boolean {
		let count = 0;
		let units = 0;
		for (const messages of groups) {
			count += messages.length;
			for (const message of messages) units += message.text.length;
		}
		// Reserve one contract-sized latest snapshot so reset remains available at capacity.
		return (
			count <= HISTORY_CAPACITY.messages - LIMITS.historyMessages &&
			units <= HISTORY_CAPACITY.textUnits - LIMITS.historyMessages * LIMITS.messagePreview
		);
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
				messages: unique([...held.messages, ...incoming.messages.slice(overlap + 1)]),
				historyCursor: !tail && held.historyCursor === null ? incoming.historyCursor : held.historyCursor,
			};
		} else {
			this.bridge = {
				snapshot: incoming,
				messages: unique(incoming.messages),
				cursor: incoming.historyCursor,
				seen: new Set(),
			};
			if (incoming.historyCursor === null) this.failed = true;
		}
	}

	private pump(force = false) {
		if (this.disposed || this.request || this.failed || this.capacity || this.scanLimited) return;
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
		if (this.pages >= HISTORY_CAPACITY.pages) {
			this.capacity = true;
			this.emit();
			return;
		}
		if (this.scanPages >= 16) {
			this.scanLimited = true;
			this.emit();
			return;
		}
		const request = new AbortController();
		this.request = request;
		this.emit();
		void this.load(cursor, bridge, request);
	}

	private async load(cursor: string, bridge: Bridge | undefined, request: AbortController) {
		try {
			const page = await this.read(cursor, request.signal);
			if (this.disposed || request !== this.request || this.capacity) return;
			this.validateScope(page);
			const seen = bridge?.seen ?? this.olderSeen;
			if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor)))
				throw new AppError("INVALID_REQUEST");
			const held = this.snapshot;
			if (!held) return;
			if (bridge) {
				const messages = unique([...page.messages, ...bridge.messages]);
				if (!this.fits(held.messages, messages, this.queued?.messages ?? [])) {
					this.capacity = true;
					return;
				}
				const tail = held.messages.at(-1);
				const overlap = tail ? messages.findIndex((message) => message.id === tail.id) : -1;
				if (overlap >= 0 || (!tail && page.nextCursor === null)) {
					this.snapshot = {
						...bridge.snapshot,
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
					bridge.messages = messages;
					bridge.cursor = page.nextCursor;
				}
			} else {
				// Held originals win when a page repeats immutable final message IDs.
				const originals = new Set(held.messages.map((message) => message.id));
				const messages = unique([...page.messages.filter((message) => !originals.has(message.id)), ...held.messages]);
				if (!this.fits(messages, this.bridge?.messages ?? [], this.queued?.messages ?? [])) {
					this.capacity = true;
					return;
				}
				this.snapshot = { ...held, messages, historyCursor: page.nextCursor };
				if (page.messages.length > 0) {
					this.nearTop = false;
					this.scanPages = -1;
				}
			}
			seen.add(cursor);
			this.pages++;
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

	private emit() {
		if (!this.disposed) this.publish(this.state);
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
