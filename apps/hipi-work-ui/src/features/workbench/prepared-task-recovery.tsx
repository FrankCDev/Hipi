import { useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { catalogLabels } from "./catalog-labels.ts";
import type { CatalogSession } from "./catalog-session.ts";
import { workbenchLabels } from "./workbench-labels.ts";

/** Interrupted first Send stays with its existing owner until the durable submit handoff finishes. */
export function PreparedTaskRecovery({
	session,
	onResolve,
}: {
	session: CatalogSession;
	onResolve: (operation: () => Promise<void>) => Promise<void>;
}) {
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	const c = catalogLabels(locale);
	const initial = state.initialSend;
	const legacy = state.preparedTask;
	if (state.busy || state.submission || (!initial && (!legacy || !state.pending))) return null;
	return (
		<section className="prepared-task-recovery notice" aria-live="polite" aria-label={l["workbench.handoffTitle"]}>
			<p>
				{initial
					? l["workbench.initialSendUnconfirmed"]
					: state.handoffConflict
						? l["workbench.handoffConflict"]
						: c.pending}
			</p>
			<details>
				<summary>{l["workbench.handoffOriginal"]}</summary>
				<pre>{initial?.text ?? legacy?.text}</pre>
			</details>
			{state.failed && <p role="alert">{c.failed}</p>}
			{state.notFound && <p>{c.notFound}</p>}
			<div className="recovery-actions">
				<Button
					variant="outline"
					size="sm"
					disabled={state.busy || state.incompatible}
					onClick={() => void onResolve(session.check)}
				>
					{c.check}
				</Button>
				{state.notFound && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void onResolve(session.retry)}
					>
						{c.retry}
					</Button>
				)}
				{state.handoffConflict && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void onResolve(session.discardPreparedTask)}
					>
						{l["workbench.handoffKeep"]}
					</Button>
				)}
			</div>
		</section>
	);
}
