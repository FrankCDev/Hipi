import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { AgentPermissions } from "../src/features/agent-permissions/agent-permissions.tsx";
import { ConversationComposer } from "../src/features/workbench/conversation-composer.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { type ConversationController, useConversation } from "../src/features/workbench/use-conversation.ts";

// Inspect safety controls inside portalled content; actual open/focus behavior is covered by native GUI acceptance.
vi.mock("../src/components/ui/dialog.tsx", () => ({
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
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call }),
	useLocalState: () => local,
	useFiles: () => ({}),
}));
vi.mock("../src/features/workbench/use-observation.ts", () => ({
	useObservation: () => ({ connection: "connected", snapshot: null, error: null, pause: vi.fn(), reconnect: vi.fn() }),
}));
vi.mock("../src/features/agent-permissions/permission-session.ts", () => ({
	MAX_UNRESOLVED_OPERATIONS: 64,
	PermissionSession: class {
		state = {
			unresolvedOperations: [],
			checkedOperation: null,
			contexts: [
				{
					...scope,
					...model,
					model,
					purpose: "live-files",
					grantId: "source",
					rootId: "old-root",
					pathPrefixes: ["src"],
					status: "invalidated",
					expiresAt: 1,
				},
			],
			activeContexts: [],
			contextMode: "history",
			approvalMode: "history",
			loaded: true,
		};
		getSnapshot = () => this.state;
		subscribe = () => () => {};
		getPending = () => null;
	},
}));
function button(html: string, label: string) {
	const match = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(([value]) => value.includes(label));
	assert.ok(match, label);
	return match[0];
}
test("archived permissions disable both new authorizations while keeping audit navigation available", () => {
	const cache = new QueryClient();
	const render = (archived: boolean) =>
		renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					<AgentPermissions scope={scope} model={model} connected archived={archived} />
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	const archived = render(true);
	assert.match(archived, /此会话已归档/);
	for (const label of ["授权模型上下文", "允许再次发送历史文件上下文"]) {
		assert.match(button(archived, label), /disabled=""/);
		assert.doesNotMatch(button(render(false), label), /disabled=""/);
	}
	assert.doesNotMatch(button(archived, "刷新"), /disabled=""/);
	assert.doesNotMatch(button(archived, "授权历史"), /disabled=""/);
	assert.equal(call.mock.calls.length, 0);
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
