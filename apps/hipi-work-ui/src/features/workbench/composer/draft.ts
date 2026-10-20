import { readCatalogRecovery } from "../catalog/prepared-task.ts";
import type { SavedValue } from "../local-persistence.ts";
import type { LocalState } from "../local-state.ts";
import {
	ACTIVE_DRAFT_KEY,
	type ActiveDraft,
	parseActiveDraft,
	sameActiveDraft,
	validHomeDraft,
} from "./draft-record.ts";

/** Storage enumeration stays with LocalState; this owner only selects references, never copies text. */
export type DraftState = Pick<LocalState, "storedValue" | "valueSnapshot" | "persistValue" | "withAdmission"> & {
	storedDraftValues: () => SavedValue[];
	unsavedDraftValues: () => SavedValue[];
};
export type DraftInventory = {
	active: ActiveDraft | null;
	activeSource: SavedValue | null;
	/** Includes a claimed source for read-only disclosure of later edits, never as a recover action. */
	retainedSources: SavedValue[];
	recoverable: SavedValue[];
	claimedSource: string | null;
	blocked: boolean;
};

function inventory(local: DraftState): DraftInventory {
	const raw = local.storedValue(ACTIVE_DRAFT_KEY)?.value;
	const active = raw === undefined ? null : parseActiveDraft(raw);
	const recovery = readCatalogRecovery(local.storedValue("command.catalog")?.value ?? null);
	const claimedSource =
		recovery.initialSend?.sourceKey ??
		(recovery.preparedTask ? `task-draft.${recovery.preparedTask.workspaceId}` : null);
	const stored = local.storedDraftValues();
	const edited = local.unsavedDraftValues();
	const records = new Map(stored.map((entry) => [entry.key, entry]));
	for (const entry of [...stored, ...edited]) {
		if (!validHomeDraft(entry.key, entry.value)) throw new Error("INVALID_HOME_DRAFT");
	}
	// Failed local writes remain visible but cannot be selected over durable text from another window.
	for (const entry of edited) {
		const saved = records.get(entry.key);
		if (saved?.value !== entry.value || saved?.revision !== entry.revision)
			throw new Error("HOME_DRAFT_STORAGE_CONFLICT");
	}
	const retainedSources = stored.filter((entry) => entry.value.length > 0 && entry.key !== active?.sourceKey);
	return {
		active,
		activeSource: active ? (records.get(active.sourceKey) ?? null) : null,
		retainedSources,
		recoverable: recovery.incompatible ? [] : retainedSources.filter((entry) => entry.key !== claimedSource),
		claimedSource,
		blocked: recovery.incompatible,
	};
}

export function readDraftInventory(local: DraftState): Promise<DraftInventory> {
	return local.withAdmission("command.catalog", () => inventory(local));
}

/** Ordinary navigation reuses the home draft. Only a claimed owner or explicit fresh intent rotates it. */
export function openHomeDraft(
	local: DraftState,
	input: { destination: string | null; expected: ActiveDraft | null; fresh?: boolean },
	signal: AbortSignal,
): Promise<DraftInventory> {
	const captured = structuredClone(input);
	return local.withAdmission("command.catalog", () => {
		signal.throwIfAborted();
		const current = inventory(local);
		if (!sameActiveDraft(current.active, captured.expected)) throw new Error("ACTIVE_DRAFT_CHANGED");
		if (current.blocked) throw new Error("CATALOG_RECOVERY_INCOMPATIBLE");
		if (current.active && current.active.sourceKey !== current.claimedSource && !captured.fresh) return current;
		const eligible = current.recoverable;
		const destinationKey = captured.destination ? `task-draft.${captured.destination}` : "chat-draft.global";
		// Adoption is initialization only. Later navigation must never restore per-project switching.
		const adopted =
			current.active || captured.fresh
				? undefined
				: (eligible.find((entry) => entry.key === destinationKey) ??
					eligible.find((entry) => entry.key === "chat-draft.global") ??
					(eligible.length === 1 ? eligible[0] : undefined));
		const active: ActiveDraft = {
			version: 1,
			generation: crypto.randomUUID(),
			sourceKey: adopted?.key ?? `new-chat-draft.${crypto.randomUUID()}`,
		};
		signal.throwIfAborted();
		local.persistValue({ kind: "value", key: ACTIVE_DRAFT_KEY, value: JSON.stringify(active) });
		return inventory(local);
	});
}

/** Explicit recovery switches the reference, leaving both the old and selected text records intact. */
export function recoverHomeDraft(
	local: DraftState,
	expected: ActiveDraft,
	candidate: SavedValue,
	signal: AbortSignal,
): Promise<DraftInventory> {
	const captured = { ...candidate };
	const owner = { ...expected };
	return local.withAdmission("command.catalog", () => {
		signal.throwIfAborted();
		const current = inventory(local);
		if (!sameActiveDraft(current.active, owner)) throw new Error("ACTIVE_DRAFT_CHANGED");
		if (current.blocked || captured.key === current.claimedSource) throw new Error("HOME_DRAFT_CLAIMED");
		const source = current.recoverable.find((entry) => entry.key === captured.key);
		if (!source || source.value !== captured.value || source.revision !== captured.revision)
			throw new Error("HOME_DRAFT_CHANGED");
		const active: ActiveDraft = { version: 1, generation: crypto.randomUUID(), sourceKey: source.key };
		signal.throwIfAborted();
		local.persistValue({ kind: "value", key: ACTIVE_DRAFT_KEY, value: JSON.stringify(active) });
		return inventory(local);
	});
}
