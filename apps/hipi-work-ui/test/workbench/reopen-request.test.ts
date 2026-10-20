import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppClient, parseResult } from "@hipi/work-runtime/contracts";
import { ReopenRequest } from "../../src/features/workbench/reopen-request.ts";

function fixture(delayed: "getWorkspace" | "getConversation") {
	const pending = Promise.withResolvers<unknown>();
	const signals: AbortSignal[] = [];
	const calls: string[] = [];
	const client: AppClient = {
		async call(method, params, signal) {
			assert.ok(signal);
			signals.push(signal);
			assert.ok("workspaceId" in params);
			calls.push(`${method}:${params.workspaceId}`);
			if (params.workspaceId === "a" && method === delayed) return parseResult(method, await pending.promise);
			return parseResult(
				method,
				method === "getWorkspace"
					? { workspaceId: params.workspaceId, name: params.workspaceId }
					: {
							workspaceId: params.workspaceId,
							conversationId: "conversation",
							title: "Conversation",
							revision: 1,
							createdAt: 1,
							archivedAt: null,
						},
			);
		},
		async observe() {
			throw new Error("Unexpected observation");
		},
	};
	return { client, pending, signals, calls };
}

for (const stage of ["getWorkspace", "getConversation"] as const) {
	test(`cancelled ${stage} cannot reopen A after B was chosen, even if transport ignores abort`, async () => {
		const { client, pending, signals, calls } = fixture(stage);
		const request = new ReopenRequest();
		const opened: string[] = [];
		const scope = { workspaceId: " a ", conversationId: " conversation " };
		const runA = request.begin(client, scope, (workspace) => opened.push(workspace.workspaceId));
		assert.ok(runA);
		assert.equal(
			request.begin(client, scope, () => assert.fail("Duplicate submit")),
			undefined,
		);
		scope.workspaceId = "edited";
		scope.conversationId = "edited";
		const resultA = runA();
		await Promise.resolve();
		request.cancel();
		assert.ok(signals.every((signal) => signal.aborted));
		const runB = request.begin(client, { workspaceId: "b", conversationId: "conversation" }, (workspace) =>
			opened.push(workspace.workspaceId),
		);
		assert.ok(runB);
		pending.resolve(
			stage === "getWorkspace"
				? { workspaceId: "a", name: "A" }
				: { workspaceId: "a", conversationId: "conversation", title: "A", revision: 1, createdAt: 1, archivedAt: null },
		);
		await resultA;
		// A's completion must not release B's synchronous submission lock.
		assert.equal(
			request.begin(client, scope, () => assert.fail("Duplicate submit")),
			undefined,
		);
		await runB();
		assert.deepEqual(opened, ["b"]);
		assert.equal(calls.includes("getWorkspace:edited"), false);
		if (stage === "getWorkspace") assert.equal(calls.includes("getConversation:a"), false);
	});
}

test("unmount cancellation ignores a late rejection and prevents queued requests from starting", async () => {
	const { client, pending, signals } = fixture("getWorkspace");
	const request = new ReopenRequest();
	const run = request.begin(client, { workspaceId: "a", conversationId: "conversation" }, () =>
		assert.fail("Opened after unmount"),
	);
	assert.ok(run);
	const result = run();
	request.cancel();
	pending.reject(new Error("Late transport failure"));
	await result;
	assert.equal(signals[0]?.aborted, true);
	const queued = request.begin(client, { workspaceId: "b", conversationId: "conversation" }, () =>
		assert.fail("Opened after unmount"),
	);
	assert.ok(queued);
	request.cancel();
	await queued();
	assert.equal(signals.length, 1);
});

test("active lookup errors remain visible and release the request for retry", async () => {
	const { client, pending } = fixture("getWorkspace");
	const request = new ReopenRequest();
	const scope = { workspaceId: "a", conversationId: "conversation" };
	const run = request.begin(client, scope, () => assert.fail("Unexpected success"));
	assert.ok(run);
	const result = run();
	pending.reject(new Error("Lookup failed"));
	await assert.rejects(result, /Lookup failed/);
	assert.ok(request.begin(client, scope, () => {}));
	request.cancel();
});

test("submission captures both trimmed IDs before the input values change", async () => {
	const { client, pending, calls } = fixture("getWorkspace");
	const request = new ReopenRequest();
	const scope = { workspaceId: " a ", conversationId: " conversation " };
	const opened: string[] = [];
	const run = request.begin(client, scope, (workspace, conversation) => {
		opened.push(`${workspace.workspaceId}:${conversation.conversationId}`);
	});
	assert.ok(run);
	scope.workspaceId = "b";
	scope.conversationId = "edited";
	const result = run();
	pending.resolve({ workspaceId: "a", name: "A" });
	await result;
	assert.deepEqual(calls, ["getWorkspace:a", "getConversation:a"]);
	assert.deepEqual(opened, ["a:conversation"]);
});
