import assert from "node:assert/strict";
import type { FileOperation } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { AgentPermissionManagement, AgentPermissions } from "../src/features/agent-permissions/agent-permissions.tsx";
import { permissionLabels } from "../src/features/agent-permissions/labels.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

const fixture = vi.hoisted(() => ({
	state: {
		approvalMode: "pending",
		unresolvedOperations: [] as FileOperation[],
		checkedOperation: null,
		operationLimitReached: false,
		contexts: [],
		activeContexts: [],
		loaded: true,
		failed: false,
		uncertain: false,
		incompatible: false,
		notFound: false,
		approval: null as { status: "pending" } | null,
		nextCursor: null as string | null,
	},
}));
const local = new LocalState();
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({}),
	useLocalState: () => local,
	useFiles: () => ({}),
}));
vi.mock("../src/features/agent-permissions/permission-session.ts", () => ({
	MAX_UNRESOLVED_OPERATIONS: 64,
	PermissionSession: class {
		getSnapshot = () => fixture.state;
		subscribe = () => () => {};
		getPending = () => null;
	},
}));
beforeEach(() => {
	fixture.state = {
		approvalMode: "pending",
		unresolvedOperations: [] as FileOperation[],
		checkedOperation: null,
		operationLimitReached: false,
		contexts: [],
		activeContexts: [],
		loaded: true,
		failed: false,
		uncertain: false,
		incompatible: false,
		notFound: false,
		approval: null,
		nextCursor: null,
	};
});
function render() {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<PreferencesProvider>
				<AgentPermissions
					scope={{ workspaceId: "workspace", conversationId: "conversation" }}
					connected
					archived={false}
				/>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
}
test("idle permissions expose a named dialog trigger without occupying the chat with audit controls", () => {
	const html = render();
	assert.match(html, /Agent 文件权限/);
	assert.match(html, /aria-haspopup="dialog"/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /批准此次写入|授权历史|第一条请求|下一条请求/);
});
test("a pending approval remains discoverable outside the closed permission dialog", () => {
	fixture.state.approval = { status: "pending" };
	assert.match(render(), /等待审批 · 1/);
	fixture.state.nextCursor = "more";
	assert.match(render(), /等待审批 · 1\+/);
	assert.doesNotMatch(render(), /批准此次写入/, "approval is possible only after opening and reviewing the proposal");
});
test("permission read failures and uncertain outcomes are never hidden by the collapsed presentation", () => {
	for (const [flag, key] of [
		["failed", "permissions.action.failed"],
		["uncertain", "permissions.action.unknown"],
		["incompatible", "permissions.action.incompatible"],
		["notFound", "permissions.action.notFound"],
	] as const) {
		fixture.state[flag] = true;
		const html = render();
		assert.ok(html.includes(permissionLabels("zh")[key]));
		assert.match(html, /role="alert"/);
		fixture.state[flag] = false;
	}
});

test("closed permissions retain an observed file side-effect warning independently from the pending page", () => {
	fixture.state.unresolvedOperations = [
		{
			workspaceId: "workspace",
			conversationId: "conversation",
			operationId: "operation",
			approvalId: "approval",
			taskId: "task",
			callId: "call",
			rootId: "root",
			path: "file.txt",
			argumentsDigest: "a".repeat(64),
			contentDigest: "a".repeat(64),
			revision: 1,
			status: "unknown",
		},
	];
	const html = render();
	assert.ok(html.includes(permissionLabels("zh")["permissions.operation.unknown"]));
	assert.ok(html.includes(permissionLabels("zh")["permissions.operation.review"]));
	assert.match(html, /role="alert"/);
	assert.doesNotMatch(html, /批准此次写入/);
});

test("capacity information never replaces a failed reconciliation explanation", () => {
	fixture.state.operationLimitReached = true;
	fixture.state.failed = true;
	const html = render();
	assert.ok(html.includes(permissionLabels("zh")["permissions.operation.limit"]));
	assert.ok(html.includes(permissionLabels("zh")["permissions.action.failed"]));
});

test("embedded permission attention remains reviewable while another capability section is active", () => {
	fixture.state.approval = { status: "pending" };
	fixture.state.uncertain = true;
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<PreferencesProvider>
				<AgentPermissionManagement
					scope={{ workspaceId: "workspace", conversationId: "conversation" }}
					connected
					archived={false}
					detailsOpen={false}
					onOpenDetails={() => {}}
				>
					{({ attention }) => <aside>{attention}</aside>}
				</AgentPermissionManagement>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	assert.match(html, /等待审批 · 1/);
	assert.ok(html.includes(permissionLabels("zh")["permissions.action.unknown"]));
	assert.doesNotMatch(html, /批准此次写入/);
});
