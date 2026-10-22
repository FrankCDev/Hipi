import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	parseAgentContext,
	parseFileOperation,
	parseToolApproval,
} from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { AgentPermissions } from "../../../src/features/agent-permissions/agent-permissions.tsx";
import type { usePermissionOwner } from "../../../src/features/agent-permissions/permission-provider.tsx";
import { PermissionSession } from "../../../src/features/agent-permissions/permission-session.ts";
import { ConversationComposer } from "../../../src/features/workbench/composer/input.tsx";
import {
	type ConversationController,
	useConversation,
} from "../../../src/features/workbench/conversation/use-conversation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

// Inspect safety controls inside portalled content; actual open/focus behavior is covered by native GUI acceptance.
vi.mock("../../../src/components/ui/dialog.tsx", () => ({
	Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
	DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
	DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
	DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
const local = new LocalState();
const call = vi.fn();
const scope = { workspaceId: "workspace", conversationId: "conversation" };
const model = { provider: "fake", modelId: "ready-model" };
let permission: ReturnType<typeof usePermissionOwner> = null;
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call }),
	useLocalState: () => local,
	useFiles: () => ({}),
}));
vi.mock("../../../src/features/workbench/conversation/use-observation.ts", () => ({
	useObservation: () => ({ connection: "connected", snapshot: null, error: null, pause: vi.fn(), reconnect: vi.fn() }),
}));
vi.mock("../../../src/features/agent-permissions/permission-provider.tsx", () => ({
	usePermissionOwner: () => permission,
}));
vi.mock("../../../src/features/files/code-editor.tsx", () => ({
	CodeDiff: ({ before, after }: { before: string; after: string }) => <div data-before={before} data-after={after} />,
}));
beforeEach(() => {
	call.mockReset();
});
afterEach(() => {
	permission?.session.dispose();
	permission = null;
});
function button(html: string, label: string) {
	const match = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(([value]) => value.includes(label));
	assert.ok(match, label);
	return match[0];
}
test("archived permissions retain continuous audit evidence and read-only checks without authorizing new work", async () => {
	const cache = new QueryClient();
	const expiresAt = Date.now() + 60000;
	const grant = parseAgentContext({
		...scope,
		model,
		purpose: "live-files",
		requestId: "grant-request",
		grantId: "source",
		rootId: "root",
		pathPrefixes: ["src"],
		status: "active",
		revision: 1,
		expiresAt,
		disclosureVersion: 1,
	});
	const historical = parseAgentContext({ ...grant, grantId: "old-source", rootId: "old-root", status: "invalidated" });
	const approval = parseToolApproval({
		...scope,
		approvalId: "approval",
		taskId: "task",
		callId: "call",
		submissionIds: ["submission"],
		receiptIds: ["receipt"],
		toolName: "hipi_files_save",
		model,
		rootId: "root",
		path: "src/file.ts",
		ifMatch: "a".repeat(64),
		text: "proposed replacement",
		beforeText: "previous content",
		beforeTextTruncated: false,
		argumentsDigest: "b".repeat(64),
		contentDigest: "c".repeat(64),
		grantId: grant.grantId,
		grantRevision: grant.revision,
		expiresAt,
		createdAt: 1,
		revision: 1,
		status: "pending",
		operationId: "operation",
	});
	const operation = parseFileOperation({
		...scope,
		operationId: "operation",
		approvalId: approval.approvalId,
		taskId: approval.taskId,
		callId: approval.callId,
		rootId: approval.rootId,
		path: approval.path,
		argumentsDigest: approval.argumentsDigest,
		contentDigest: approval.contentDigest,
		status: "unknown",
		revision: 1,
	});
	call.mockImplementation(async (method: string) => {
		switch (method) {
			case "listActiveAgentContexts":
				return [grant];
			case "listAgentContexts":
				return { items: [historical], nextCursor: "older-contexts" };
			case "listPendingToolApprovals":
			case "listToolApprovals":
				return { items: [approval], nextCursor: "older-approvals" };
			case "getFileOperation":
				return operation;
			default:
				throw new Error(`Unexpected permission command: ${method}`);
		}
	});
	const session = new PermissionSession({ call: call as AppClient["call"], observe: vi.fn() }, scope, local);
	await session.contextHistory("history");
	session.reviewHistory("history");
	session.contextList.setActive(true);
	session.approvalList.setActive(true);
	await session.contextList.load();
	await session.approvalList.load();
	assert.equal(session.getSnapshot().loaded, true);
	assert.equal(session.getSnapshot().failed, false);
	call.mockClear();
	const render = (archived: boolean) => {
		permission = {
			scope,
			session,
			state: session.getSnapshot(),
			now: Date.now(),
			setNow: () => {},
			connected: true,
			archived,
			visible: true,
		};
		return renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<AgentPermissions scope={scope} model={model} connected archived={archived} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	};
	const archived = render(true);
	assert.match(archived, /此会话已归档/);
	const restored = render(false);
	for (const label of ["授权额外文件上下文", "允许再次发送历史文件上下文", "批准此次写入", "拒绝此次写入"]) {
		assert.match(button(archived, label), /disabled=""/);
		assert.doesNotMatch(button(restored, label), /disabled=""/);
	}
	for (const label of ["明确授予的上下文权限历史", "写入审批历史", "只读核对结果"])
		assert.doesNotMatch(button(archived, label), /disabled=""/);
	assert.match(archived, /data-management-key="old-source"/);
	assert.match(archived, /data-management-key="approval"/);
	assert.match(archived, /old-root \/ src/);
	assert.match(archived, /data-before="previous content" data-after="proposed replacement"/);
	assert.equal(
		[...archived.matchAll(/<section aria-label="(?:明确授予的上下文权限历史|写入审批历史)" tabindex="0"/g)].length,
		2,
	);
	assert.doesNotMatch(archived, /刷新本页|第一页|下一页|第一条请求|下一条请求|>刷新</);
	assert.equal(call.mock.calls.length, 0);
	call.mockRejectedValueOnce(new Error("offline"));
	await session.contextList.load("refresh");
	const failed = render(true);
	assert.equal(session.contextList.getSnapshot().failed, true);
	assert.match(failed, /data-management-key="old-source"/);
	assert.doesNotMatch(button(failed, "重试加载"), /disabled=""/);
	assert.doesNotMatch(button(failed, "只读核对结果"), /disabled=""/);
	assert.deepEqual(
		call.mock.calls.map(([method]) => method),
		["listAgentContexts"],
	);
	await session.contextList.retry();
	assert.equal(session.contextList.getSnapshot().failed, false);
	assert.match(render(true), /data-management-key="old-source"/);
	assert.deepEqual(
		call.mock.calls.map(([method]) => method),
		["listAgentContexts", "listAgentContexts"],
	);
	cache.clear();
});
test("ready model cannot submit archived draft; restoring keeps draft and does not execute", () => {
	const cache = new QueryClient();
	cache.setQueryData(["conversation-model", scope.workspaceId, scope.conversationId], {
		...scope,
		model,
		credentialState: "configured",
		executionState: "ready",
	});
	local.write("draft.workspace.conversation", "preserved draft");
	let controller: ConversationController | undefined;
	function Probe({ conversation }: { conversation: Conversation }) {
		controller = useConversation(conversation);
		return <ConversationComposer controller={controller} />;
	}
	const render = (archivedAt: number | null) =>
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<Probe conversation={{ ...scope, title: "Archived", revision: 2, createdAt: 1, archivedAt }} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	assert.match(button(render(2), "提交任务"), /disabled=""/);
	assert.ok(controller);
	assert.equal(controller.blocked, true);
	controller.submit();
	assert.equal(call.mock.calls.length, 0);
	assert.doesNotMatch(button(render(null), "提交任务"), /disabled=""/);
	assert.equal(local.read("draft.workspace.conversation"), "preserved draft");
	assert.equal(call.mock.calls.length, 0, "restore render neither resumes nor authorizes nor submits");
	cache.clear();
});
