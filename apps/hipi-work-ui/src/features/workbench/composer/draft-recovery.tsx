import { useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import type { SavedValue } from "../local-persistence.ts";
import type { DraftInventory } from "./draft.ts";
import { draftLabels } from "./draft-labels.ts";
import { draftOrigin } from "./draft-record.ts";

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
	const [page, setPage] = useState(0);
	const sources = inventory?.retainedSources ?? [];
	const offset = Math.min(page, Math.max(0, Math.ceil(sources.length / 10) - 1)) * 10;
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
					{sources.slice(offset, offset + 10).map((source) => {
						const origin = draftOrigin(source.key);
						const eligible = inventory?.recoverable.some((entry) => entry.key === source.key);
						return (
							<details key={source.key}>
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
					{offset > 0 && (
						<Button variant="outline" size="sm" onClick={() => setPage(offset / 10 - 1)}>
							{labels.previous}
						</Button>
					)}
					{sources.length > offset + 10 && (
						<Button variant="outline" size="sm" onClick={() => setPage(offset / 10 + 1)}>
							{labels.next}
						</Button>
					)}
				</>
			)}
		</section>
	);
}
