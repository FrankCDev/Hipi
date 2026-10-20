import { useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import type { CatalogSession } from "./catalog-session.ts";
import { workbenchLabels } from "./workbench-labels.ts";

/** The same catalog owner remains authoritative, including after the setup dialog is dismissed. */
export function PreparedTaskRecovery({ session, onResolved }: { session: CatalogSession; onResolved: () => void }) {
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	const c = catalogLabels(locale);
	if (!state.preparedTask || !state.pending) return null;
	return (
		<section className="prepared-task-recovery notice" aria-live="polite" aria-label={l["workbench.handoffTitle"]}>
			<p>{state.handoffConflict ? l["workbench.handoffConflict"] : c.pending}</p>
			<details>
				<summary>{l["workbench.handoffOriginal"]}</summary>
				<pre>{state.preparedTask.text}</pre>
			</details>
			{state.failed && <p role="alert">{c.failed}</p>}
			{state.notFound && <p>{c.notFound}</p>}
			<div className="recovery-actions">
				<Button
					variant="outline"
					size="sm"
					disabled={state.busy || state.incompatible}
					onClick={() => void session.check().then(onResolved)}
				>
					{c.check}
				</Button>
				{state.notFound && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void session.retry().then(onResolved)}
					>
						{c.retry}
					</Button>
				)}
				{state.handoffConflict && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void session.discardPreparedTask().then(onResolved)}
					>
						{l["workbench.handoffKeep"]}
					</Button>
				)}
			</div>
		</section>
	);
}
