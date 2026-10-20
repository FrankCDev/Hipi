import type { AgentContext, FileOperation, ToolApproval } from "@hipi/work-runtime/contracts";
import { Button } from "../../components/ui/button.tsx";
import { CodeDiff } from "../files/code-editor.tsx";
import { permissionLabels } from "./labels.ts";
import { canDecide } from "./permission-session.ts";

export function ApprovalCard({
	approval,
	operation,
	contexts,
	now,
	locale,
	disabled,
	approveDisabled = false,
	reconcileDisabled,
	onDecide,
	onReconcile,
}: {
	approval: ToolApproval;
	operation: FileOperation | null;
	contexts: AgentContext[];
	now: number;
	locale: string;
	disabled: boolean;
	approveDisabled?: boolean;
	reconcileDisabled: boolean;
	onDecide: (decision: "approve" | "reject") => void;
	onReconcile: () => void;
}) {
	const l = permissionLabels(locale);
	const date = (value: number) =>
		new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(value);
	return (
		<article className="approval-card">
			<header className="approval-header">
				<div className="approval-heading">
					<h3>{l["permissions.approval.title"]}</h3>
					<p>{approval.toolName}</p>
				</div>
				<span className="approval-status" data-status={approval.status}>
					{l[`permissions.status.${approval.status}`]}
				</span>
			</header>
			<p className="approval-target">
				{approval.rootId} / {approval.path}
			</p>
			<dl className="approval-facts">
				<div>
					<dt>{l["permissions.context.scope"]}</dt>
					<dd>
						{approval.workspaceId} / {approval.conversationId}
					</dd>
				</div>
				<div>
					<dt>{l["permissions.context.model"]}</dt>
					<dd>
						{approval.model.provider} / {approval.model.modelId}
					</dd>
				</div>
				<div>
					<dt>{l["permissions.context.expires"]}</dt>
					<dd>{date(approval.expiresAt)}</dd>
				</div>
				<div>
					<dt>{l["permissions.approval.version"]}</dt>
					<dd className="approval-version">{approval.ifMatch}</dd>
				</div>
			</dl>
			{operation && (
				<output className="approval-outcome" data-status={operation.status}>
					<p>{l[`permissions.status.${operation.status}`]}</p>
					{operation.status === "observed_match" && <p>{l["permissions.operation.observed"]}</p>}
					{(operation.status === "unknown" || operation.status === "executing") && (
						<p>{l["permissions.operation.unknown"]}</p>
					)}
				</output>
			)}
			{approval.operationId && (
				<Button
					className="approval-reconcile"
					variant="outline"
					size="sm"
					disabled={reconcileDisabled}
					onClick={onReconcile}
				>
					{l["permissions.operation.reconcile"]}
				</Button>
			)}
			{approval.beforeTextTruncated && (
				<p className="approval-warning" role="note">
					{l["permissions.approval.partial"]}
				</p>
			)}
			<details className="approval-diff" open>
				<summary>{l["permissions.approval.diff"]}</summary>
				<div className="h-64 overflow-auto">
					<CodeDiff
						before={approval.beforeText}
						after={approval.text}
						left={l["permissions.approval.before"]}
						right={l["permissions.approval.after"]}
					/>
				</div>
			</details>
			<details className="approval-provenance">
				<summary>{l["permissions.approval.digest"]}</summary>
				<p>{approval.argumentsDigest}</p>
				<p>{approval.contentDigest}</p>
				<p>
					{l["permissions.approval.task"]}: {approval.taskId} / {approval.callId} / {approval.submissionIds.join(", ")}{" "}
					/ {approval.receiptIds.join(", ")}
				</p>
			</details>
			<p className="approval-note">{l["permissions.approval.note"]}</p>
			<div className="approval-actions">
				{(["approve", "reject"] as const).map((decision) => (
					<Button
						key={decision}
						variant={decision === "approve" ? "default" : "outline"}
						disabled={disabled || (decision === "approve" && approveDisabled) || !canDecide(approval, contexts, now)}
						onClick={() => onDecide(decision)}
					>
						{l[`permissions.approval.${decision}`]}
					</Button>
				))}
			</div>
		</article>
	);
}
