import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import type { SavedValue } from "../local-persistence.ts";
import type { DraftInventory } from "./draft.ts";
import { draftLabels } from "./draft-labels.ts";
import { draftOrigin } from "./draft-record.ts";
import "./draft-recovery.css";

/** Conditional migration/recovery state only; ordinary new-chat presentation has no saved-drafts menu. */
export function DraftRecovery({
	inventory,
	busy,
	failed,
	onRecover,
	onReload,
	projectName,
}: {
	inventory: DraftInventory | null;
	busy: boolean;
	failed: boolean;
	onRecover: (source: SavedValue) => void;
	onReload: () => void;
	projectName: (id: string) => string;
}) {
	const { locale } = usePreferences();
	const labels = draftLabels(locale);

	const sources = inventory?.retainedSources ?? [];
	if (!failed && sources.length === 0) return null;
	return (
		<section className="prepared-task-recovery notice" aria-label={labels.title}>
			{failed && <p role="alert">{labels.failed}</p>}
			{failed && (
				<Button variant="outline" size="sm" disabled={busy} onClick={onReload}>
					{labels.retry}
				</Button>
			)}
			{sources.length > 0 && (
				<>
					<p>{labels.description}</p>
					<RecoverySources
						sources={sources}
						recoverable={inventory?.recoverable ?? []}
						busy={busy}
						onRecover={onRecover}
						projectName={projectName}
					/>
				</>
			)}
		</section>
	);
}

/** Presentation only: inventory owns the records and recovery remains an explicit action.
 * Expansion stores keys, not text. Only visible rows and live interaction owners stay mounted. */
function RecoverySources({
	sources,
	recoverable,
	busy,
	onRecover,
	projectName,
}: {
	sources: SavedValue[];
	recoverable: SavedValue[];
	busy: boolean;
	onRecover: (source: SavedValue) => void;
	projectName: (id: string) => string;
}) {
	const { locale } = usePreferences();
	const labels = draftLabels(locale);
	const viewport = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [focused, setFocused] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [pending, setPending] = useState<{ key: string; last: boolean } | null>(null);
	const rangeExtractor = useCallback(
		(range: Range) => {
			const indices = new Set(defaultRangeExtractor(range));
			for (const key of [...selected, focused, pending?.key]) {
				const index = sources.findIndex((source) => source.key === key);
				if (index >= 0) indices.add(index);
			}
			return [...indices].sort((a, b) => a - b);
		},
		[sources, selected, focused, pending],
	);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDetailsElement>({
		count: sources.length,
		getScrollElement: () => viewport.current,
		getItemKey: (index) => sources[index]?.key ?? index,
		estimateSize: () => 32,
		overscan: 4,
		rangeExtractor,
	});
	useEffect(() => {
		const selectionChanged = () => {
			const selection = document.getSelection();
			const keys: string[] = [];
			if (selection && !selection.isCollapsed) {
				for (const row of viewport.current?.querySelectorAll<HTMLElement>("[data-draft-key]") ?? []) {
					for (let index = 0; index < selection.rangeCount; index++) {
						if (selection.getRangeAt(index).intersectsNode(row)) {
							if (row.dataset.draftKey) keys.push(row.dataset.draftKey);
							break;
						}
					}
				}
			}
			setSelected((previous) => (previous.join("\0") === keys.join("\0") ? previous : keys));
		};
		document.addEventListener("selectionchange", selectionChanged);
		return () => document.removeEventListener("selectionchange", selectionChanged);
	}, []);
	useLayoutEffect(() => {
		if (!pending) return;
		const row = [...(viewport.current?.querySelectorAll<HTMLDetailsElement>("[data-draft-key]") ?? [])].find(
			(row) => row.dataset.draftKey === pending.key,
		);
		const target =
			pending.last && row?.open
				? (row.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? row.querySelector("summary"))
				: row?.querySelector("summary");
		target?.focus({ preventScroll: true });
		setPending(null);
	}, [pending]);
	return (
		<div
			className="draft-recovery-viewport"
			ref={viewport}
			onFocusCapture={(event) =>
				setFocused((event.target as HTMLElement).closest<HTMLElement>("[data-draft-key]")?.dataset.draftKey ?? null)
			}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
			}}
		>
			<div className="draft-recovery-size" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((item) => {
					const source = sources[item.index];
					if (!source) return null;
					const origin = draftOrigin(source.key);
					const eligible = recoverable.some((entry) => entry.key === source.key);
					return (
						<details
							key={source.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							data-draft-key={source.key}
							className="draft-recovery-source"
							style={{ top: item.start }}
							open={expanded.has(source.key)}
							onKeyDown={(event) => {
								if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
								const target = event.target;
								if (!(target instanceof HTMLElement)) return;
								const row = target.closest<HTMLDetailsElement>("[data-draft-key]");
								if (!row) return;
								const index = sources.findIndex((source) => source.key === row.dataset.draftKey);
								const button = row.open ? row.querySelector("button:not(:disabled)") : null;
								if (event.shiftKey ? target.tagName !== "SUMMARY" : target !== (button ?? row.querySelector("summary")))
									return;
								const next = index + (event.shiftKey ? -1 : 1);
								if (next < 0 || next >= sources.length) return;
								event.preventDefault();
								const nextSource = sources[next];
								if (!nextSource) return;
								setPending({ key: nextSource.key, last: event.shiftKey });
								virtualizer.scrollToIndex(next, { align: "auto" });
							}}
							onToggle={(event) => {
								const open = event.currentTarget.open;
								setExpanded((previous) => {
									if (previous.has(source.key) === open) return previous;
									const next = new Set(previous);
									if (open) next.add(source.key);
									else next.delete(source.key);
									return next;
								});
								virtualizer.measureElement(event.currentTarget);
							}}
						>
							<summary>
								{origin === null ? labels.projectless : origin === undefined ? labels.unknown : projectName(origin)}
							</summary>
							<pre>{source.value}</pre>
							{eligible ? (
								<Button variant="outline" size="sm" disabled={busy} onClick={() => onRecover(source)}>
									{origin === undefined ? labels.recoverCurrent : labels.recover}
								</Button>
							) : (
								<p>{labels.claimed}</p>
							)}
						</details>
					);
				})}
			</div>
		</div>
	);
}
