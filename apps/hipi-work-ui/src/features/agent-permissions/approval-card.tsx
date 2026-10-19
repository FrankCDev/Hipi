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
	reconcileDisabled: boolean;
	onDecide: (decision: "approve" | "reject") => void;
	onReconcile: () => void;
}) {
	const l = permissionLabels(locale);
	const date = (value: number) =>
		new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(value);
	return (
		<article className="rounded-md border border-border p-3 grid gap-2 break-all">
			<h3>
				{l["permissions.approval.title"]}: {approval.toolName}
			</h3>
			<p>
				{l["permissions.context.scope"]}: {approval.workspaceId} / {approval.conversationId}
			</p>
			<p>
				{approval.rootId} / {approval.path}
			</p>
			<p>
				{l["permissions.context.model"]}: {approval.model.provider} / {approval.model.modelId}
			</p>
			<p>
				{l[`permissions.status.${approval.status}`]} · {l["permissions.context.expires"]}: {date(approval.expiresAt)}
			</p>
			<p>
				{l["permissions.approval.version"]}: {approval.ifMatch}
			</p>
			<details>
				<summary>{l["permissions.approval.digest"]}</summary>
				<p>{approval.argumentsDigest}</p>
				<p>{approval.contentDigest}</p>
				<p>
					{l["permissions.approval.task"]}: {approval.taskId} / {approval.callId} / {approval.submissionIds.join(", ")}{" "}
					/ {approval.receiptIds.join(", ")}
				</p>
			</details>
			{approval.beforeTextTruncated && <p role="note">{l["permissions.approval.partial"]}</p>}
			<details>
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
			<p>{l["permissions.approval.note"]}</p>
			<div className="flex flex-wrap gap-2">
				{(["approve", "reject"] as const).map((decision) => (
					<Button
						key={decision}
						variant={decision === "approve" ? "default" : "outline"}
						disabled={disabled || !canDecide(approval, contexts, now)}
						onClick={() => onDecide(decision)}
					>
						{l[`permissions.approval.${decision}`]}
					</Button>
				))}
			</div>
			{operation && (
				<output>
					<p>{l[`permissions.status.${operation.status}`]}</p>
					{operation.status === "observed_match" && <p>{l["permissions.operation.observed"]}</p>}
					{(operation.status === "unknown" || operation.status === "executing") && (
						<p>{l["permissions.operation.unknown"]}</p>
					)}
				</output>
			)}
			{approval.operationId && (
				<Button variant="outline" size="sm" disabled={reconcileDisabled} onClick={onReconcile}>
					{l["permissions.operation.reconcile"]}
				</Button>
			)}
		</article>
	);
}
