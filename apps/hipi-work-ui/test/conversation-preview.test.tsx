import assert from "node:assert/strict";
import type { AppClient, ConversationModel } from "@hipi/work-runtime/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { AppClientProvider } from "../src/app/client-provider.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ConversationPane } from "../src/features/workbench/conversation-pane.tsx";
import { ConversationPreview } from "../src/features/workbench/conversation-preview.tsx";
import type { ConnectionState } from "../src/features/workbench/use-observation.ts";

const fixture = vi.hoisted(() => ({
	connection: "connected" as ConnectionState,
	modelError: false,
	executionError: false,
	executionState: "ready" as ConversationModel["executionState"],
}));
// Layout contract only: runtime and nested content keep their own behavioral suites.
vi.mock("../src/features/workbench/use-conversation.ts", () => ({
	useConversation: () => ({
		observation: { connection: fixture.connection, snapshot: { running: false } },
		reconnect: () => {},
		workspaceId: "workspace",
		model: {
			data: {
				model: { provider: "openai", modelId: "gpt/test.v1" },
				credentialState: "configured",
				executionState: fixture.executionState,
			},
			isError: fixture.modelError,
			isPending: false,
			isFetching: false,
			refetch: () => {},
		},
		execution: { isError: fixture.executionError, isPending: false, mutate: () => {} },
	}),
}));
vi.mock("../src/features/workbench/conversation-history.tsx", () => ({ ConversationHistory: () => null }));
vi.mock("../src/features/workbench/conversation-composer.tsx", () => ({
	ConversationComposer: ({ controls, activity }: { controls: ReactNode; activity: ReactNode }) => (
		<>
			{activity}
			{controls}
		</>
	),
}));
vi.mock("../src/features/workbench/conversation-receipt.tsx", () => ({ ConversationReceipt: () => null }));
vi.mock("../src/features/agent-permissions/agent-permissions.tsx", () => ({ AgentPermissions: () => null }));

const conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Conversation title",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};

const client: AppClient = {
	async call() {
		throw new Error("Static conversation rendering must not issue runtime calls");
	},
	async observe() {
		throw new Error("Static conversation rendering must not start observation");
	},
};

function renderPane(connection: ConnectionState, detailsOpen = false) {
	fixture.connection = connection;
	return renderToStaticMarkup(
		<PreferencesProvider>
			<AppClientProvider client={client}>
				<ConversationPane conversation={conversation} detailsOpen={detailsOpen} onDetailsClose={() => {}} />
			</AppClientProvider>
		</PreferencesProvider>,
	);
}

test("connected conversation has an accessible heading but no repeated visible header or connection row", () => {
	const html = renderPane("connected");
	assert.match(html, /<h1 class="sr-only">Conversation title<\/h1>/);
	assert.doesNotMatch(html, /conversation-header|connection-bar/);
	assert.doesNotMatch(html, /diagnostics-panel|diagnostics-grid/);
	assert.match(html, /aria-label="模型状态"/);
});

test("stale and paused connections retain explanation and reconnect without claiming current idle", () => {
	for (const connection of ["stale", "paused"] as const) {
		const html = renderPane(connection, true);
		assert.match(html, /connection-bar/);
		assert.match(html, /重新连接并核对/);
		assert.doesNotMatch(html, /当前无执行/);
		assert.doesNotMatch(html, /class="diagnostics-panel"[^>]*hidden/);
	}
});

test("connecting displays an honest transitional notice without a redundant reconnect action", () => {
	const html = renderPane("connecting");
	assert.match(html, /正在连接/);
	assert.doesNotMatch(html, /重新连接并核对/);
});

test("preview row owns the selection surface and preserves navigation plus a named ellipsis trigger", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationPreview
				conversation={conversation}
				workspaceName="Workspace"
				selected
				onSelect={() => {}}
				onDetails={() => {}}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /aria-current="page"/);
	assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="true"/);
	assert.match(html, /class="conversation-link"/);
	assert.match(html, /lucide-ellipsis/);
	assert.doesNotMatch(html, /conversation-preview-trigger|conversation-link selected/);
	assert.match(html, /aria-haspopup="dialog"/);
	assert.match(html, /aria-expanded="false"/);
	assert.match(html, /aria-labelledby="[^"]+ [^"]+"/);
	assert.equal((html.match(/<button /g) ?? []).length, 2);
	assert.doesNotMatch(html, /当前无执行|执行中|connected|title="/);
});

test("paused workspace offers explicit resume and a cancellation request that does not start execution", () => {
	fixture.executionState = "paused";
	try {
		const html = renderPane("connected");
		assert.match(html, /恢复整个工作区/);
		assert.match(html, /工作区恢复待授权/);
		assert.match(html, />取消执行<\/button>/);
		assert.match(html, /暂停时仅保存取消请求，不启动运行时/);
		assert.match(html, /gpt\/test.v1/);
		// Credential detail is available in the model popover, not a permanent row.
		assert.match(html, /aria-haspopup="dialog"/);
	} finally {
		fixture.executionState = "ready";
	}
});

test("recorded cancellation stays distinct from completed cancellation and cannot be resubmitted", () => {
	fixture.executionState = "cancellation_pending";
	try {
		const html = renderPane("connected");
		assert.match(html, /取消请求已保存，等待恢复处理/);
		assert.match(html, /恢复整个工作区/);
		assert.doesNotMatch(html, />取消执行<\/button>/);
	} finally {
		fixture.executionState = "ready";
	}
});

test("running model exposes execution cancellation separately from observation", () => {
	fixture.executionState = "running";
	try {
		const html = renderPane("connected");
		assert.match(html, />取消执行<\/button>/);
		assert.doesNotMatch(html, /恢复整个工作区/);
	} finally {
		fixture.executionState = "ready";
	}
});

test("collapsed model details do not hide read or execution failures", () => {
	fixture.modelError = true;
	fixture.executionError = true;
	try {
		const html = renderPane("connected");
		assert.match(html, /role="alert">模型状态读取失败/);
		assert.match(html, /role="alert">操作结果未确认/);
	} finally {
		fixture.modelError = false;
		fixture.executionError = false;
	}
});
