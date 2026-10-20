import type { Conversation, ReceiptView, Submit, Workspace } from "@hipi/work-runtime/contracts";
import {
	type BrowserStorage,
	browserStorage,
	LocalPersistence,
	type SavedEntry,
	type SavedPending,
	type SavedValue,
	validTaskDraft,
} from "./local-persistence.ts";

export type NavigationIndex = { workspaces: Workspace[]; conversations: Conversation[] };
/** Runtime facts stay in the core. Only a verified store identity enables local input restoration. */
export class LocalState {
	navigation: NavigationIndex = { workspaces: [], conversations: [] };
	readonly #values = new Map<string, SavedValue>();
	readonly #pending = new Map<string, Submit>();
	readonly #pendingDraftRevisions = new Map<string, string | null>();
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
				if (entry.kind === "value") this.#values.set(entry.key, entry);
				else {
					this.#pending.set(entry.key, entry.input);
					if (entry.draftRevision !== undefined)
						this.#pendingDraftRevisions.set(entry.input.requestId, entry.draftRevision);
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
		return this.#values.get(key)?.value ?? null;
	}
	write(key: string, value: string): boolean {
		if (!this.#active || !this.#leaseActive()) return false;
		if ((key.startsWith("task-draft.") || key === "chat-draft.global") && !validTaskDraft(key, value)) return false;
		const previous = this.#values.get(key);
		const entry: SavedValue = {
			kind: "value",
			key,
			value,
			...(key.startsWith("draft.") || validTaskDraft(key, value) ? { revision: crypto.randomUUID() } : {}),
			...(previous?.handoffRequestId ? { handoffRequestId: previous.handoffRequestId } : {}),
			...(previous?.handoffRevision ? { handoffRevision: previous.handoffRevision } : {}),
		};
		this.#values.set(key, entry);
		return this.#save(entry);
	}
	/** Captures local edits, including a write that could not yet be persisted. */
	valueSnapshot(key: string): SavedValue | null {
		const entry = this.#values.get(key);
		return entry ? { ...entry } : null;
	}
	/** Read authoritative browser recovery data while holding its admission lock. */
	storedValue(key: string): SavedValue | null {
		if (!this.#active || !this.#leaseActive()) throw new Error("Connection is closed");
		try {
			if (this.#persistence) return this.#persistence.readValue(key);
			if (this.#requiresPersistence) throw new Error("Recovery storage is unavailable");
			return this.valueSnapshot(key);
		} catch (error) {
			this.storageAvailable = false;
			throw error;
		}
	}
	/** Recovery writes become visible only after durability; ordinary editing remains memory-first. */
	persistValue(entry: SavedValue): void {
		if (!this.#save(entry)) throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
		this.#values.set(entry.key, { ...entry });
	}
	pending(key: string): Submit | null {
		const value = this.#pending.get(key);
		return value ? { ...value } : null;
	}
	/** Serialize browser tabs' read/check/write admission; the network call follows only after this resolves. */
	async rememberForSubmission(
		key: string,
		input: Submit,
		options?: { onlyIfNew?: boolean; draftRevision?: string | null },
	): Promise<boolean> {
		const captured = { ...input };
		const onlyIfNew = options?.onlyIfNew;
		const draft = this.valueSnapshot(`draft.${key}`);
		// Capture before waiting for admission, including absence. Later edits never acquire this Send's ownership.
		const draftRevision =
			options?.draftRevision !== undefined
				? options.draftRevision
				: draft?.value === captured.text
					? (draft.revision ?? null)
					: null;
		return this.withAdmission(key, () => {
			const previous = this.storedPending(key);
			if (onlyIfNew && previous?.input.requestId === captured.requestId) {
				if (JSON.stringify(previous.input) !== JSON.stringify(captured))
					throw new Error("Pending request payload is immutable");
				this.#pending.set(key, { ...previous.input });
				if (previous.draftRevision !== undefined)
					this.#pendingDraftRevisions.set(captured.requestId, previous.draftRevision);
				return false;
			}
			this.remember(key, captured, draftRevision);
			return true;
		});
	}
	/** Reads pending ownership from the same store before any retry or initial-send transfer. */
	storedPending(key: string): SavedPending | null {
		if (!this.#active || !this.#leaseActive()) throw new Error("Connection is closed");
		if (this.#persistence) return this.#persistence.readPending(key);
		if (this.#requiresPersistence) throw new Error("Recovery storage is unavailable");
		const input = this.#pending.get(key);
		const draftRevision = input ? this.#pendingDraftRevisions.get(input.requestId) : undefined;
		return input
			? {
					kind: "pending",
					key,
					input: { ...input },
					confirmed: this.#confirmed.has(input.requestId),
					...(draftRevision !== undefined ? { draftRevision } : {}),
				}
			: null;
	}
	async withAdmission<T>(key: string, work: () => T): Promise<T> {
		const admitted = () => {
			if (!this.#active || !this.#leaseActive()) throw new Error("Connection is closed");
			return work();
		};
		if (!this.#requiresPersistence) return admitted();
		if (typeof navigator === "undefined" || !navigator.locks) {
			this.storageAvailable = false;
			throw new Error("Safe browser storage is unavailable");
		}
		return navigator.locks.request(`hipi.work.admission.${this.#storeId}.${key}`, admitted);
	}
	clearDraft(key: string, expected: string): boolean {
		const previous = this.#values.get(key);
		if (!this.#active || !this.#leaseActive() || previous?.value !== expected) return false;
		const pending = this.#pending.get(key.replace(/^draft\./, ""));
		const expectedRevision = pending ? this.#pendingDraftRevisions.get(pending.requestId) : undefined;
		if (expectedRevision !== undefined && previous.revision !== expectedRevision) return false;
		const revision = crypto.randomUUID();
		this.#values.set(key, { ...previous, value: "", revision });
		if (!this.#persistence) return !this.#requiresPersistence;
		try {
			return this.#persistence.clearDraft(key, expected, revision, expectedRevision);
		} catch {
			this.storageAvailable = false;
			return false;
		}
	}
	remember(key: string, input: Submit, draftRevision?: string | null) {
		if (!this.#active || !this.#leaseActive()) throw new Error("Connection is closed");
		const previous = this.#pending.get(key);
		if (previous?.requestId === input.requestId && JSON.stringify(previous) !== JSON.stringify(input))
			throw new Error("Pending request payload is immutable");
		const stored = this.storedPending(key);
		const capturedRevision =
			stored?.input.requestId === input.requestId
				? stored.draftRevision
				: draftRevision !== undefined
					? draftRevision
					: this.#values.get(`draft.${key}`)?.revision;
		if (
			!this.#save({
				kind: "pending",
				key,
				input,
				confirmed: this.#confirmed.has(input.requestId),
				...(capturedRevision !== undefined ? { draftRevision: capturedRevision } : {}),
			})
		)
			throw new Error("Cannot preserve pending request for recovery");
		this.#pending.set(key, { ...input });
		if (capturedRevision !== undefined) this.#pendingDraftRevisions.set(input.requestId, capturedRevision);
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
				if (
					this.#persistence &&
					!this.#persistence.matchesDraft(`draft.${key}`, this.#values.get(`draft.${key}`)?.value)
				) {
					this.storageAvailable = false;
					continue;
				}
				const draftRevision = this.#pendingDraftRevisions.get(input.requestId);
				this.#save({
					kind: "pending",
					key,
					input,
					confirmed: true,
					...(draftRevision !== undefined ? { draftRevision } : {}),
				});
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
				([key, entry]) =>
					((key.startsWith("draft.") || validTaskDraft(key, entry.value)) && entry.value.length > 0) ||
					(key.startsWith("command.") && entry.value !== JSON.stringify({ version: 2, request: null })),
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
