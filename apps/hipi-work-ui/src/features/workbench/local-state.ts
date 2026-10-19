import type { Conversation, ReceiptView, Submit, Workspace } from "@hipi/work-runtime/contracts";
import { type BrowserStorage, browserStorage, LocalPersistence, type SavedEntry } from "./local-persistence.ts";

export type NavigationIndex = { workspaces: Workspace[]; conversations: Conversation[] };
/** Runtime facts stay in the core. Only a verified store identity enables local input restoration. */
export class LocalState {
	navigation: NavigationIndex = { workspaces: [], conversations: [] };
	readonly #values = new Map<string, string>();
	readonly #pending = new Map<string, Submit>();
	readonly #unconfirmed = new Set<string>();
	readonly #confirmed = new Set<string>();
	readonly #persistence: LocalPersistence | undefined;
	readonly #requiresPersistence: boolean;
	readonly #storeId: string | undefined;
	readonly #leaseActive: () => boolean;
	#active = true;
	storageAvailable = false;
	constructor(
		storeId?: string,
		storage: BrowserStorage | undefined = browserStorage(),
		leaseActive: () => boolean = () => true,
	) {
		this.#requiresPersistence = storeId !== undefined;
		this.#storeId = storeId;
		this.#leaseActive = leaseActive;
		if (!storeId || !storage) return;
		try {
			this.#persistence = new LocalPersistence(storeId, storage);
			for (const entry of this.#persistence.load()) {
				if (entry.kind === "value") this.#values.set(entry.key, entry.value);
				else {
					this.#pending.set(entry.key, entry.input);
					if (entry.confirmed) this.#confirmed.add(entry.input.requestId);
					else this.#unconfirmed.add(entry.input.requestId);
				}
			}
			this.storageAvailable = true;
		} catch {
			/* Storage denial leaves input usable in memory; submissions require a saved retry payload. */
		}
	}
	activate() {
		this.#active = true;
	}
	deactivate() {
		this.#active = false;
	}
	#save(entry: SavedEntry): boolean {
		if (!this.#active || !this.#leaseActive()) return false;
		if (!this.#persistence) return !this.#requiresPersistence;
		try {
			this.#persistence.save(entry);
			this.storageAvailable = true;
			return true;
		} catch {
			this.storageAvailable = false;
			return false;
		}
	}
	read(key: string): string | null {
		return this.#values.get(key) ?? null;
	}
	write(key: string, value: string): boolean {
		if (!this.#active || !this.#leaseActive()) return false;
		this.#values.set(key, value);
		return this.#save({ kind: "value", key, value });
	}
	pending(key: string): Submit | null {
		const value = this.#pending.get(key);
		return value ? { ...value } : null;
	}
	/** Serialize browser tabs' read/check/write admission; the network call follows only after this resolves. */
	async rememberForSubmission(key: string, input: Submit): Promise<void> {
		if (!this.#requiresPersistence) return this.remember(key, input);
		if (typeof navigator === "undefined" || !navigator.locks) {
			this.storageAvailable = false;
			throw new Error("Safe browser storage is unavailable");
		}
		await navigator.locks.request(`hipi.work.admission.${this.#storeId}.${key}`, () => this.remember(key, input));
	}
	clearDraft(key: string, expected: string): boolean {
		if (!this.#active || !this.#leaseActive() || this.#values.get(key) !== expected) return false;
		this.#values.set(key, "");
		if (!this.#persistence) return !this.#requiresPersistence;
		try {
			return this.#persistence.clearDraft(key, expected);
		} catch {
			this.storageAvailable = false;
			return false;
		}
	}
	remember(key: string, input: Submit) {
		if (!this.#active || !this.#leaseActive()) throw new Error("Connection is closed");
		const previous = this.#pending.get(key);
		if (previous?.requestId === input.requestId && JSON.stringify(previous) !== JSON.stringify(input))
			throw new Error("Pending request payload is immutable");
		if (!this.#save({ kind: "pending", key, input, confirmed: this.#confirmed.has(input.requestId) }))
			throw new Error("Cannot preserve pending request for recovery");
		this.#pending.set(key, { ...input });
		this.#unconfirmed.add(input.requestId);
	}
	confirmed(requestId: string) {
		if (!this.#active || !this.#leaseActive()) return;
		this.#unconfirmed.delete(requestId);
		this.#confirmed.add(requestId);
		for (const [key, input] of this.#pending) {
			if (input.requestId !== requestId) continue;
			// The marker must never outlive a failed draft clear: reload must retry reconciliation first.
			try {
				if (this.#persistence && !this.#persistence.matchesDraft(`draft.${key}`, this.#values.get(`draft.${key}`))) {
					this.storageAvailable = false;
					continue;
				}
				this.#save({ kind: "pending", key, input, confirmed: true });
			} catch {
				this.storageAvailable = false;
			}
		}
	}
	isConfirmed(requestId: string): boolean {
		return this.#confirmed.has(requestId);
	}
	hasUnsavedWork(): boolean {
		return (
			this.#unconfirmed.size > 0 ||
			[...this.#values].some(
				([key, value]) =>
					(key.startsWith("draft.") && value.length > 0) ||
					(key.startsWith("command.") && value !== JSON.stringify({ version: 2, request: null })),
			)
		);
	}
}

/** A receipt can clear only its own unchanged submitted draft, never later user edits. */
export function reconciledDraft(
	draft: string,
	pending: Submit | null,
	receipt: ReceiptView | null | undefined,
): string {
	if (!pending || !receipt || receipt.state === "reconciliation_required" || receipt.state === "cancelled")
		return draft;
	if (
		receipt.requestId !== pending.requestId ||
		receipt.workspaceId !== pending.workspaceId ||
		receipt.conversationId !== pending.conversationId
	)
		return draft;
	return draft === pending.text ? "" : draft;
}
