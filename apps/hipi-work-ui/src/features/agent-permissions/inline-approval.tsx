import type { Snapshot } from "@hipi/work-runtime/contracts";
import { usePreferences } from "../../app/preferences.tsx";
import { ApprovalCard } from "./approval-card.tsx";
import { matchesExecutionApproval } from "./approval-correlation.ts";
import { usePermissionOwner } from "./permission-provider.tsx";
import { MAX_UNRESOLVED_OPERATIONS } from "./permission-session.ts";

export function InlineApproval({ snapshot, active }: { snapshot: Snapshot; active: boolean }) {
	const owner = usePermissionOwner();
	const { locale } = usePreferences();
	if (!owner || !active || !snapshot.running || !owner.connected || !owner.visible) return null;
	const { state, session, now } = owner;
	const approval = state.approval;
	if (
		owner.scope.workspaceId !== snapshot.workspaceId ||
		owner.scope.conversationId !== snapshot.conversationId ||
		!matchesExecutionApproval(approval, snapshot, snapshot.execution, now)
	)
		return null;
	return (
		<div data-preserve-turn-viewport="">
			<ApprovalCard
				approval={approval}
				operation={state.operation}
				contexts={state.activeContexts}
				now={now}
				locale={locale}
				disabled={owner.archived || state.busy || state.failed || state.uncertain || !state.loaded}
				approveDisabled={state.unresolvedOperations.length >= MAX_UNRESOLVED_OPERATIONS}
				reconcileDisabled={state.busy || !owner.connected}
				onDecide={(decision) => void session.decide(approval, decision)}
				onReconcile={() => void session.refresh(true)}
			/>
		</div>
	);
}
