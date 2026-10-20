import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedValue } from "../local-persistence.ts";
import type { LocalState } from "../local-state.ts";
import { type DraftInventory, openHomeDraft, readDraftInventory, recoverHomeDraft } from "./draft.ts";
import { ACTIVE_DRAFT_KEY, parseActiveDraft, sameActiveDraft } from "./draft-record.ts";

/** Owns navigation-time draft loading, not initial Send or any runtime recovery operation. */
export function useHomeDraft(local: LocalState, workspaceId: string, conversationId: string, focusRevision: number) {
	const [inventory, setInventory] = useState<DraftInventory | null>(null);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [, setDefaultRevision] = useState(0);
	const intent = useRef<AbortController | null>(null);
	const current = useRef(inventory);
	const cancel = useCallback(() => {
		intent.current?.abort();
		intent.current = null;
	}, []);
	const accept = useCallback(
		(next: DraftInventory, controller: AbortController) =>
			local.withAdmission("command.catalog", () => {
				if (controller.signal.aborted || intent.current !== controller) return false;
				const stored = local.storedValue(ACTIVE_DRAFT_KEY);
				const active = stored ? parseActiveDraft(stored.value) : null;
				if (!sameActiveDraft(active, next.active)) throw new Error("ACTIVE_DRAFT_CHANGED");
				// Inventory may have waited behind another window's edit; publish the exact refreshed source.
				const activeSource = active ? local.refreshDraftValue(active.sourceKey) : null;
				const accepted = { ...next, activeSource };
				current.current = accepted;
				setInventory(accepted);
				setText(activeSource?.value ?? "");
				setFailed(false);
				return true;
			}),
		[local],
	);
	const load = useCallback(
		async (open: boolean) => {
			cancel();
			if (conversationId) return;
			const controller = new AbortController();
			intent.current = controller;
			setBusy(true);
			try {
				const existing = await readDraftInventory(local);
				controller.signal.throwIfAborted();
				const next = open
					? await openHomeDraft(
							local,
							{ destination: workspaceId || null, expected: existing.active },
							controller.signal,
						)
					: existing;
				await accept(next, controller);
			} catch {
				if (!controller.signal.aborted && intent.current === controller) setFailed(true);
			} finally {
				if (!controller.signal.aborted && intent.current === controller) setBusy(false);
			}
		},
		[local, workspaceId, conversationId, cancel, accept],
	);
	useEffect(() => {
		void focusRevision;
		void load(true);
		return cancel;
	}, [load, focusRevision, cancel]);
	useEffect(() => {
		const changed = (event: StorageEvent) => {
			if (event.key === null || event.key.endsWith(".value.default-chat-workspace")) {
				setDefaultRevision((value) => value + 1);
			}
			if (
				event.key === null ||
				event.key.endsWith(".value.new-chat.active") ||
				event.key.includes(".value.task-draft.") ||
				event.key.includes(".value.new-chat-draft.") ||
				event.key.endsWith(".value.chat-draft.global") ||
				event.key.endsWith(".value.command.catalog")
			)
				void load(false);
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [load]);
	const change = (value: string) => {
		const active = current.current?.active;
		if (!active) return;
		// Keep input memory-first even if persistence fails; Send revalidates its exact durable source.
		local.write(active.sourceKey, value);
		setText(value);
	};
	const recover = async (candidate: SavedValue): Promise<boolean> => {
		const active = current.current?.active;
		if (!active || busy) return false;
		cancel();
		const controller = new AbortController();
		intent.current = controller;
		setBusy(true);
		try {
			return await accept(await recoverHomeDraft(local, active, candidate, controller.signal), controller);
		} catch {
			if (!controller.signal.aborted && intent.current === controller) setFailed(true);
			return false;
		} finally {
			if (!controller.signal.aborted && intent.current === controller) setBusy(false);
		}
	};
	return {
		inventory,
		text,
		busy,
		failed,
		cancel,
		change,
		recover,
		refresh: () => load(false),
		reload: () => load(true),
	};
}
