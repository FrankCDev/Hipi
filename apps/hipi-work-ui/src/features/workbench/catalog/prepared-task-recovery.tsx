import { useSyncExternalStore } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { preparedProjectConsentLabels } from "../composer/project-consent-labels.ts";
import { workbenchLabels } from "../workbench-labels.ts";
import { catalogLabels } from "./labels.ts";
import type { CatalogSession } from "./session.ts";

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
	const p = preparedProjectConsentLabels(locale);
	const initial = state.initialSend;
	const legacy = state.preparedTask;
	if (state.busy || (state.submission && !initial) || (!initial && (!legacy || !state.pending))) return null;
	return (
		<section className="prepared-task-recovery notice" aria-live="polite" aria-label={l["workbench.handoffTitle"]}>
			<p>
				{initial
					? state.initialConsentStage === "create"
						? p.recoveryCreate
						: state.initialConsentStage === "authorize"
							? p.recoveryAuthorize
							: state.initialConsentStage === "submit"
								? p.recoverySubmit
								: l["workbench.initialSendUnconfirmed"]
					: state.handoffConflict
						? l["workbench.handoffConflict"]
						: c.pending}
			</p>
			<details>
				<summary>{l["workbench.handoffOriginal"]}</summary>
				<pre>{initial?.text ?? legacy?.text}</pre>
			</details>
			{state.failed && <p role="alert">{c.failed}</p>}
			{state.initialConsentInvalidated && <p role="alert">{p.recoveryInvalid}</p>}
			{state.initialConsentGrantActive && <p>{p.grantRemains}</p>}
			{state.notFound && <p>{c.notFound}</p>}
			{initial && state.handoffConflict && (
				<>
					<p>{p.combineDescription}</p>
					{state.failed && <p role="alert">{p.combineFailed}</p>}
				</>
			)}
			<div className="recovery-actions">
				<Button
					variant="outline"
					size="sm"
					disabled={state.busy || state.incompatible}
					onClick={() => void onResolve(session.check)}
				>
					{c.check}
				</Button>
				{state.notFound && !state.initialConsentInvalidated && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void onResolve(session.retry)}
					>
						{c.retry}
					</Button>
				)}
				{state.initialConsentCanRecoverDraft && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void onResolve(session.recoverInitialDraft)}
					>
						{initial?.conversationId ? p.recoverDraft : p.recoverSource}
					</Button>
				)}
				{initial && state.handoffConflict && state.initialConsentCanRecoverDraft && (
					<Button
						variant="outline"
						size="sm"
						disabled={state.busy || state.incompatible}
						onClick={() => void onResolve(session.combineInitialDraft)}
					>
						{p.combine}
					</Button>
				)}
				{!initial && state.handoffConflict && (
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
