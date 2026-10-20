import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { test, vi } from "vitest";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import type { CatalogCommand } from "../../../src/features/workbench/command-recovery.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

const created: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Original",
	revision: 1,
	createdAt: 100,
	archivedAt: null,
};
const create: CatalogCommand = {
	version: PROTOCOL_VERSION,
	method: "createConversation",
	params: {
		workspaceId: "workspace",
		requestId: "original-request",
		title: "Original",
		model: { provider: "fake", modelId: "test" },
	},
};
function fixture(local = new LocalState()) {
	const calls: { method: Method; params: unknown; signal?: AbortSignal }[] = [];
	let handler: (method: Method, params: unknown, signal?: AbortSignal) => Promise<unknown> = async (method) => {
		if (method === "getConversationCommandResult") return null;
		if (method === "getConversation") return created;
		throw new Error("Lost response");
	};
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ method, params, signal });
			return parseResult(method, await handler(method, params, signal));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	return {
		calls,
		client,
		local,
		session: new CatalogSession(client, local),
		handle: (next: typeof handler) => {
			handler = next;
		},
	};
}
test("lost create reply checks exact command receipt then current item, without a second create or execution", async () => {
	const f = fixture();
	f.handle(async (method) => {
		if (method === "createConversation") throw new Error("Lost reply");
		if (method === "getConversationCommandResult") return { method: "createConversation", result: created };
		return { ...created, title: "Renamed later", revision: 3, archivedAt: 200 };
	});
	await f.session.execute(create);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["createConversation", "getConversationCommandResult", "getConversation"],
	);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.deepEqual(f.session.getSnapshot().result, {
		...created,
		title: "Renamed later",
		revision: 3,
		archivedAt: 200,
	});
	f.session.dispose();
});
test("unknown creation survives closing/remount and retries only the explicitly selected immutable request", async () => {
	const f = fixture();
	const input = structuredClone(create);
	await f.session.execute(input);
	input.params.title = "Edited";
	assert.equal(f.session.getSnapshot().notFound, true);
	await f.session.execute({ ...create, params: { ...create.params, requestId: "replacement" } });
	assert.equal(f.calls.filter((call) => call.method === "createConversation").length, 1);
	f.session.dispose();
	const restored = new CatalogSession(f.client, f.local);
	await restored.check();
	assert.equal(f.calls.filter((call) => call.method === "createConversation").length, 1);
	await restored.retry();
	assert.deepEqual(
		f.calls.filter((call) => call.method === "createConversation").map((call) => call.params),
		[create.params, create.params],
	);
	assert.equal(f.local.hasUnsavedWork(), true);
	restored.dispose();
});
test("workspace creation is checked by exact read-only workspace identity and name", async () => {
	const f = fixture();
	f.handle(async (method) => {
		if (method === "createWorkspace") throw new Error("Lost");
		if (method === "getWorkspace") return { workspaceId: "new-workspace", name: "Project" };
		throw new Error("Unexpected side effect");
	});
	await f.session.execute({
		version: PROTOCOL_VERSION,
		method: "createWorkspace",
		params: { workspaceId: "new-workspace", name: "Project" },
	});
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["createWorkspace", "getWorkspace"],
	);
	assert.equal(f.session.getSnapshot().pending, null);
	f.session.dispose();
});
test("rename, archive and restore use revision CAS and never resume or modify permissions", async () => {
	for (const method of ["renameConversation", "archiveConversation", "restoreConversation"] as const) {
		const f = fixture();
		const result = {
			...created,
			revision: 2,
			title: method === "renameConversation" ? "Renamed" : created.title,
			archivedAt: method === "archiveConversation" ? 300 : null,
		};
		f.handle(async () => result);
		const params = {
			workspaceId: created.workspaceId,
			conversationId: created.conversationId,
			requestId: method,
			expectedRevision: 1,
		};
		await f.session.execute(
			method === "renameConversation"
				? { version: PROTOCOL_VERSION, method, params: { ...params, title: "Renamed" } }
				: { version: PROTOCOL_VERSION, method, params },
		);
		assert.deepEqual(
			f.calls.map((call) => call.method),
			[method, "getConversation"],
		);
		assert.equal(f.session.getSnapshot().pending, null);
		f.session.dispose();
	}
});
test("wrong command, foreign scope and foreign current object do not clear pending recovery", async () => {
	for (const mismatch of ["method", "scope", "current"] as const) {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "createConversation") throw new Error("Lost");
			if (method === "getConversationCommandResult")
				return {
					method: mismatch === "method" ? "archiveConversation" : "createConversation",
					result: { ...created, workspaceId: mismatch === "scope" ? "other" : created.workspaceId },
				};
			return { ...created, conversationId: mismatch === "current" ? "other" : created.conversationId };
		});
		await f.session.execute(create);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.ok(f.session.getSnapshot().pending);
		f.session.dispose();
	}
});
test("unmount and timeout release waits; late results cannot clear original recovery records", async () => {
	vi.useFakeTimers();
	try {
		for (const cancel of [true, false]) {
			const f = fixture();
			const pending = Promise.withResolvers<unknown>();
			f.handle(() => pending.promise);
			const run = f.session.execute(create);
			// Durable catalog admission now resolves before dispatch; exercise cancellation after dispatch.
			await Promise.resolve();
			if (cancel) {
				f.session.dispose();
				f.session.activate();
			} else await vi.advanceTimersByTimeAsync(15000);
			await run;
			pending.resolve(created);
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(f.calls[0]?.signal?.aborted, true);
			assert.ok(f.session.getSnapshot().pending);
			assert.equal(f.session.getSnapshot().result, null);
			f.session.dispose();
		}
	} finally {
		vi.useRealTimers();
	}
});

test("an incompatible old creation record is neither discarded nor treated as a replayable command", async () => {
	const local = new LocalState();
	const raw = JSON.stringify({
		version: 1,
		request: { method: "createConversation", params: { workspaceId: "workspace", title: "Old title" } },
	});
	local.write("command.catalog", raw);
	const f = fixture(local);
	await f.session.check();
	await f.session.execute(create);
	await f.session.retry();
	assert.equal(f.session.getSnapshot().incompatible, true);
	assert.deepEqual(f.calls, []);
	assert.equal(local.read("command.catalog"), raw);
	f.session.dispose();
});
