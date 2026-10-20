import type { ModelReference, Scope } from "@hipi/work-runtime/contracts";
import { ShieldCheck } from "lucide-react";
import {
	type MouseEventHandler,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { projectFolderLabels } from "../workbench/project-folder-labels.ts";
import { useProjectFolder } from "../workbench/use-project-folder.ts";
import { ApprovalCard } from "./approval-card.tsx";
import { ContextDialog } from "./context-dialog.tsx";
import { permissionLabels } from "./labels.ts";
import { MAX_UNRESOLVED_OPERATIONS, PermissionSession } from "./permission-session.ts";
import { RetainedContextDialog } from "./retained-context-dialog.tsx";

type AgentPermissionsProps = {
	scope: Scope;
	model?: ModelReference;
	connected: boolean;
	archived: boolean;
};

type ContextAction = {
	disabled: boolean;
	onClick: MouseEventHandler<HTMLButtonElement>;
	"aria-haspopup": "dialog";
	"aria-expanded": boolean;
	"aria-controls": string;
};

/** Keep the live session outside any sheet or section so alerts and recovery survive dismissal. */
export function AgentPermissionManagement({
	scope,
	model,
	connected,
	archived,
	detailsOpen,
	onOpenDetails,
	onContextRestoreFocus,
	children,
}: AgentPermissionsProps & {
	detailsOpen: boolean;
	onOpenDetails: MouseEventHandler<HTMLButtonElement>;
	onContextRestoreFocus?: () => void;
	children: (view: { content: ReactNode; attention: ReactNode; contextAction: ContextAction }) => ReactNode;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const boundScope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
	const { locale } = usePreferences();
	const l = permissionLabels(locale);
	const pl = projectFolderLabels(locale);
	const project = useProjectFolder(scope.workspaceId, connected);
	const [session] = useState(
		() =>
			new PermissionSession(client, { workspaceId: scope.workspaceId, conversationId: scope.conversationId }, local),
	);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [contextOpen, setContextOpen] = useState(false);
	const contextTrigger = useRef<HTMLButtonElement | null>(null);
	const contextId = useId();
	const [now, setNow] = useState(Date.now);
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	useEffect(() => {
		if (!connected || !visible || state.failed) {
			session.cancel();
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			await session.refresh();
			if (stopped) return;
			setNow(Date.now());
			// Single-page, single-flight polling only while the active conversation is visible.
			if (!session.getSnapshot().failed) timer = setTimeout(() => void poll(), 2000);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
			session.cancel();
		};
	}, [session, connected, visible, state.failed]);
	useEffect(() => {
		// Closed audit views return to the pending queue so new approvals stay discoverable.
		if (
			!detailsOpen &&
			connected &&
			!state.busy &&
			!state.failed &&
			!state.uncertain &&
			state.approvalMode !== "pending"
		)
			void session.approvalHistory("pending");
	}, [detailsOpen, connected, state.busy, state.failed, state.uncertain, state.approvalMode, session]);
	const disabled = state.busy || state.failed || state.uncertain || !connected || !state.loaded;
	const contextAction: ContextAction = {
		disabled: disabled || archived || !model,
		onClick: (event) => {
			contextTrigger.current = event.currentTarget;
			setContextOpen(true);
		},
		"aria-haspopup": "dialog",
		"aria-expanded": contextOpen,
		"aria-controls": contextId,
	};
	const pending = session.getPending();
	const projectAuthorized =
		project.data?.root &&
		state.activeContexts.some(
			(context) =>
				context.purpose === "live-files" &&
				context.rootId === project.data?.root?.rootId &&
				context.status === "active" &&
				context.expiresAt > now &&
				context.model.provider === model?.provider &&
				context.model.modelId === model?.modelId,
		);
	const approval = state.approval;
	const operation = state.operation;
	const date = (value: number) =>
		new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(value);
	const notices = (
		<>
			{state.operationLimitReached && <output>{l["permissions.operation.limit"]}</output>}
			{state.failed && <p role="alert">{l["permissions.action.failed"]}</p>}
			{state.uncertain && <p role="alert">{l["permissions.action.unknown"]}</p>}
			{state.incompatible && <p role="alert">{l["permissions.action.incompatible"]}</p>}
			{state.notFound && <p role="alert">{l["permissions.action.notFound"]}</p>}
		</>
	);
	const content = (
		<div className="permission-panel grid gap-4">
			{state.unresolvedOperations.length > 0 && (
				<section className="grid gap-3" aria-label={l["permissions.operation.attention"]}>
					<h3>{l["permissions.operation.attention"]}</h3>
					<p role="alert">{l["permissions.operation.unknown"]}</p>
					{state.unresolvedOperations.map((item) => (
						<div key={item.operationId} className="rounded-md border border-border p-3 grid gap-2 break-all">
							<p>
								{item.rootId} / {item.path}
							</p>
							<p>
								{item.operationId} / {item.approvalId}
							</p>
							<details>
								<summary>{l["permissions.approval.digest"]}</summary>
								<p>
									{item.taskId} / {item.callId}
								</p>
								<p>
									{item.argumentsDigest} / {item.contentDigest}
								</p>
							</details>
							<Button
								variant="outline"
								size="sm"
								disabled={state.busy || !connected}
								onClick={() => void session.reconcileOperation(item.operationId)}
							>
								{l["permissions.operation.reconcile"]}
							</Button>
						</div>
					))}
				</section>
			)}
			{state.checkedOperation && (
				<output className="grid gap-1 break-all">
					<p>
						{state.checkedOperation.path} / {state.checkedOperation.operationId}
					</p>
					<p>{l[`permissions.status.${state.checkedOperation.status}`]}</p>
					{state.checkedOperation.status === "observed_match" && <p>{l["permissions.operation.observed"]}</p>}
				</output>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" {...contextAction}>
					{l["permissions.context.authorize"]}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={state.busy || !connected}
					onClick={() => void session.refresh().then(() => setNow(Date.now()))}
				>
					{l["permissions.action.refresh"]}
				</Button>
			</div>
			{archived && <output>{l["permissions.archived"]}</output>}
			{state.busy && <output>{l["permissions.action.loading"]}</output>}
			{notices}
			{pending && (
				<details>
					<summary>{l["permissions.action.original"]}</summary>
					<p>
						{pending.method} / {pending.params.requestId}
					</p>
					<p>
						{pending.params.workspaceId} / {pending.params.conversationId}
					</p>
					{(pending.method === "authorizeAgentContext" || pending.method === "authorizeRetainedContext") && (
						<>
							<p>
								{
									l[
										pending.method === "authorizeRetainedContext"
											? "permissions.retained.disclosure"
											: "permissions.context.disclosure"
									]
								}
							</p>
							<p>
								{pending.params.model.provider} / {pending.params.model.modelId}
							</p>
							<p>
								{l["permissions.context.expires"]}: {date(pending.params.expiresAt)}
							</p>
							{pending.method === "authorizeAgentContext" ? (
								<p>
									{pending.params.rootId} / {pending.params.pathPrefixes.map((path) => path || "/").join(", ")}
								</p>
							) : (
								<p>
									{l["permissions.retained.source"]}: {pending.params.sourceGrantId}
								</p>
							)}
						</>
					)}
					{pending.method === "revokeAgentContext" && (
						<p>
							{l["permissions.context.revoke"]}: {pending.params.grantId} / {pending.params.expectedRevision}
						</p>
					)}
					{pending.method === "decideToolApproval" && (
						<p>
							{pending.params.approvalId} / {pending.params.decision} / {pending.params.argumentsDigest} /{" "}
							{pending.params.contentDigest}
						</p>
					)}
					{state.notFound && !state.incompatible && (
						<Button
							variant="outline"
							disabled={state.busy || !connected || (archived && pending.method !== "revokeAgentContext")}
							onClick={() => void session.retry()}
						>
							{l["permissions.action.retryOriginal"]}
						</Button>
					)}
				</details>
			)}
			<div className="flex flex-wrap gap-1">
				<Button
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected}
					aria-pressed={state.contextMode === "active"}
					onClick={() => void session.contextHistory("active")}
				>
					{l["permissions.context.active"]}
				</Button>
				<Button
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected}
					aria-pressed={state.contextMode === "history"}
					onClick={() => void session.contextHistory("history")}
				>
					{l["permissions.context.history"]}
				</Button>
			</div>
			<details open={state.contextMode === "history"}>
				<summary>
					{l[state.contextMode === "active" ? "permissions.context.active" : "permissions.context.history"]} (
					{state.contexts.length})
				</summary>
				<p>{l["permissions.context.revokeNote"]}</p>
				<p>{l["permissions.retained.restart"]}</p>
				{state.contexts.length === 0 && <p>{l["permissions.context.none"]}</p>}
				{state.contexts.map((context) => (
					<div key={context.grantId} className="border-t border-border py-2 grid gap-1 break-all">
						<p className="font-medium">
							{l[context.purpose === "retained-context" ? "permissions.retained.tag" : "permissions.retained.live"]}
						</p>
						{context.purpose === "retained-context" && (
							<p>
								{l["permissions.retained.source"]}: {context.sourceGrantId}
							</p>
						)}
						<p>
							{context.rootId} / {context.pathPrefixes.map((path) => path || "/").join(", ")} · {context.model.provider}{" "}
							/ {context.model.modelId}
						</p>
						<p>
							{
								l[
									`permissions.status.${context.status === "active" && context.expiresAt <= now ? "expired" : context.status}`
								]
							}{" "}
							· {l["permissions.context.expires"]}: {date(context.expiresAt)}
						</p>
						{context.purpose === "live-files" && (
							<RetainedContextDialog
								scope={boundScope}
								source={context}
								model={model}
								session={session}
								disabled={disabled || archived}
								disabledReason={archived ? l["permissions.archived"] : undefined}
							/>
						)}
						<Button
							variant="outline"
							size="sm"
							disabled={disabled || context.status !== "active" || context.expiresAt <= now}
							onClick={() => void session.revoke(context)}
						>
							{l["permissions.context.revoke"]}
						</Button>
					</div>
				))}
				{state.contextMode === "history" && (
					<div className="flex gap-1">
						<Button
							variant="ghost"
							disabled={state.busy || state.uncertain || !connected}
							onClick={() => void session.contextHistory("history")}
						>
							{l["permissions.action.first"]}
						</Button>
						<Button
							variant="ghost"
							disabled={state.busy || state.uncertain || !connected || !state.contextCursor}
							onClick={() => {
								if (state.contextCursor) void session.contextHistory("history", state.contextCursor);
							}}
						>
							{l["permissions.action.next"]}
						</Button>
					</div>
				)}
			</details>
			<div className="flex flex-wrap gap-1">
				<Button
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected}
					aria-pressed={state.approvalMode === "pending"}
					onClick={() => void session.approvalHistory("pending")}
				>
					{l["permissions.approval.pending"]}
				</Button>
				<Button
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected}
					aria-pressed={state.approvalMode === "history"}
					onClick={() => void session.approvalHistory("history")}
				>
					{l["permissions.approval.history"]}
				</Button>
			</div>
			{approval ? (
				<ApprovalCard
					approval={approval}
					approveDisabled={state.unresolvedOperations.length >= MAX_UNRESOLVED_OPERATIONS}
					operation={operation}
					contexts={state.activeContexts}
					now={now}
					locale={locale}
					disabled={disabled || archived}
					reconcileDisabled={state.busy || !connected}
					onDecide={(decision) => void session.decide(approval, decision)}
					onReconcile={() => void session.refresh(true)}
				/>
			) : (
				state.loaded && <p>{l["permissions.approval.none"]}</p>
			)}
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected}
					onClick={() => void session.page()}
				>
					{l["permissions.action.first"]}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={state.busy || state.uncertain || !connected || !state.nextCursor}
					onClick={() => {
						if (state.nextCursor) void session.page(state.nextCursor);
					}}
				>
					{l["permissions.action.next"]}
				</Button>
			</div>
		</div>
	);
	const attention = !detailsOpen && (
		<div className="permission-attention" aria-live="polite">
			{project.data?.status === "available" && !projectAuthorized && !archived && (
				<div className="project-context-notice">
					<span>
						<ShieldCheck size={14} aria-hidden="true" />
						{pl.currentChat}
					</span>
					<Button variant="ghost" size="sm" {...contextAction}>
						{pl.authorize}
					</Button>
				</div>
			)}
			{state.unresolvedOperations.length > 0 && (
				<>
					<p role="alert">{l["permissions.operation.unknown"]}</p>
					<Button variant="outline" size="sm" onClick={onOpenDetails}>
						{l["permissions.operation.review"]} ·{" "}
						{new Intl.NumberFormat(locale).format(state.unresolvedOperations.length)}
					</Button>
				</>
			)}
			{approval?.status === "pending" && (
				<Button variant="outline" size="sm" onClick={onOpenDetails}>
					{l["permissions.status.pending"]} · {state.approvalMode === "pending" && state.nextCursor ? "1+" : "1"}
				</Button>
			)}
			{notices}
		</div>
	);
	return (
		<>
			{children({ content, attention, contextAction })}
			{/* This owner is never removed with a management sheet or section. Both entries share its draft. */}
			<ContextDialog
				scope={boundScope}
				model={model}
				session={session}
				disabled={disabled || archived}
				disabledReason={archived ? l["permissions.archived"] : undefined}
				open={contextOpen}
				onOpenChange={setContextOpen}
				contentId={contextId}
				status={
					<div className="permission-attention" aria-live="polite">
						{state.busy && <output>{l["permissions.action.loading"]}</output>}
						{state.unresolvedOperations.length > 0 && <p role="alert">{l["permissions.operation.unknown"]}</p>}
						{approval?.status === "pending" && <output>{l["permissions.status.pending"]}</output>}
						{notices}
					</div>
				}
				onCloseAutoFocus={(event) => {
					if (contextTrigger.current?.isConnected) {
						event.preventDefault();
						contextTrigger.current.focus();
					} else if (onContextRestoreFocus) {
						event.preventDefault();
						onContextRestoreFocus();
					}
				}}
			/>
		</>
	);
}

export function AgentPermissions(props: AgentPermissionsProps) {
	const { locale } = usePreferences();
	const l = permissionLabels(locale);
	const [open, setOpen] = useState(false);
	return (
		<AgentPermissionManagement {...props} detailsOpen={open} onOpenDetails={() => setOpen(true)}>
			{({ content, attention }) => (
				<section className="permission-controls" aria-label={l["permissions.title"]}>
					<Dialog open={open} onOpenChange={setOpen}>
						<DialogTrigger asChild>
							<Button variant="ghost" size="sm">
								<ShieldCheck size={15} aria-hidden="true" />
								{l["permissions.title"]}
							</Button>
						</DialogTrigger>
						<DialogContent
							placement="right"
							className="workbench-detail-dialog permission-detail-dialog"
							closeLabel={l["permissions.action.close"]}
							aria-describedby={undefined}
						>
							<DialogTitle>{l["permissions.title"]}</DialogTitle>
							<DialogBody>{content}</DialogBody>
						</DialogContent>
					</Dialog>
					{attention}
				</section>
			)}
		</AgentPermissionManagement>
	);
}
