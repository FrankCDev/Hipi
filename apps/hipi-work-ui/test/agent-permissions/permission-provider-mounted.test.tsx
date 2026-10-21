// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Method, type Params, parseResult, type ToolApproval } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PermissionProvider, usePermissionOwner } from "../../src/features/agent-permissions/permission-provider.tsx";
import { LocalState } from "../../src/features/workbench/local-state.ts";

let local = new LocalState();
const calls: { method: Method; conversationId: string; signal?: AbortSignal }[] = [];
let intercept: ((method: Method, conversationId: string) => Promise<unknown>) | undefined;
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
		const conversationId = "conversationId" in params ? String(params.conversationId) : "";
		calls.push({ method, conversationId, signal });
		const result = await intercept?.(method, conversationId);
		return parseResult(
			method,
			result === undefined ? (method === "listActiveAgentContexts" ? [] : { items: [], nextCursor: null }) : result,
		);
	},
	observe: async () => ({ dispose: async () => {} }),
};
vi.mock("../../src/app/client-provider.tsx", () => ({ useAppClient: () => client, useLocalState: () => local }));
const owners = new Set<unknown>();
let current: ReturnType<typeof usePermissionOwner>;
function Consumer() {
	const owner = usePermissionOwner();
	assert.ok(owner);
	owners.add(owner.session);
	current = owner;
	return (
		<span>
			{owner.scope.conversationId}:{owner.state.approval?.approvalId ?? "none"}
		</span>
	);
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	calls.length = 0;
	owners.clear();
	current = null;
	intercept = undefined;
	local = new LocalState();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
});
const scope = { workspaceId: "w", conversationId: "c" };
test("real permission session is shared by inline and management consumers, not one per turn", async () => {
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected>
				<Consumer key="inline" />
				<Consumer key="modal" />
			</PermissionProvider>,
		),
	);
	assert.equal(owners.size, 1);
	assert.equal(calls.filter((c) => c.method === "listPendingToolApprovals").length, 1);
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	assert.equal(calls.filter((c) => c.method === "listPendingToolApprovals").length, 2);
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected>
				<Consumer key="next-turn" />
			</PermissionProvider>,
		),
	);
	assert.equal(owners.size, 1);
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected={false}>
				<Consumer />
			</PermissionProvider>,
		),
	);
	await act(async () => vi.advanceTimersByTimeAsync(6000));
	assert.equal(calls.filter((c) => c.method === "listPendingToolApprovals").length, 2);
});
test("scope changes abort old reads and late proposals cannot mutate the new owner", async () => {
	let release: (value: unknown) => void = () => {};
	intercept = async (method, id) =>
		method === "listPendingToolApprovals" && id === "c"
			? new Promise((resolve) => {
					release = resolve;
				})
			: undefined;
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected>
				<Consumer />
			</PermissionProvider>,
		),
	);
	const old = calls.find((call) => call.method === "listPendingToolApprovals");
	assert.ok(old);
	await act(async () =>
		root.render(
			<PermissionProvider scope={{ ...scope, conversationId: "other" }} connected>
				<Consumer />
			</PermissionProvider>,
		),
	);
	assert.equal(old.signal?.aborted, true);
	assert.equal(owners.size, 2);
	await act(async () => release({ items: [], nextCursor: null }));
	assert.equal(host.textContent, "other:none");
	assert.equal(current?.state.failed, false);
});
test("unknown immutable decisions survive surface replacement without mutation replay", async () => {
	const approval: ToolApproval = {
		...scope,
		approvalId: "a",
		taskId: "12",
		callId: "call",
		submissionIds: ["10"],
		receiptIds: [],
		toolName: "hipi_files_save",
		model: { provider: "test", modelId: "test" },
		rootId: "r",
		path: "a.txt",
		ifMatch: "a".repeat(64),
		text: "a",
		beforeText: "",
		beforeTextTruncated: false,
		argumentsDigest: "a".repeat(64),
		contentDigest: "a".repeat(64),
		grantId: "g",
		grantRevision: 1,
		expiresAt: Date.now() + 60000,
		createdAt: 1,
		revision: 1,
		status: "pending",
	};
	intercept = async (method) => {
		if (method === "listActiveAgentContexts")
			return [
				{
					...scope,
					purpose: "live-files",
					requestId: "context",
					rootId: "r",
					pathPrefixes: [""],
					model: approval.model,
					expiresAt: approval.expiresAt,
					disclosureVersion: 1,
					grantId: "g",
					revision: 1,
					status: "active",
				},
			];
		if (method === "listPendingToolApprovals") return { items: [approval], nextCursor: null };
		if (method === "decideToolApproval") throw new Error("lost transport reply");
		if (method === "getAgentCommandResult") return null;
		return undefined;
	};
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected>
				<Consumer />
			</PermissionProvider>,
		),
	);
	assert.ok(current);
	const session = current.session;
	// A lost response must leave the exact command retained, not produce another write.
	await act(async () => session.decide(approval, "approve"));
	assert.equal(session.getSnapshot().uncertain, true);
	await act(async () =>
		root.render(
			<PermissionProvider scope={scope} connected>
				<Consumer key="other-surface" />
				<Consumer />
			</PermissionProvider>,
		),
	);
	assert.equal(owners.size, 1);
	assert.equal(current?.state.uncertain, true);
	assert.equal(calls.filter((c) => c.method === "decideToolApproval").length, 1);
	assert.equal(session.getPending()?.method, "decideToolApproval");
});
