import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, type Message as PiMessage } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type AppClient, type ConversationSearchHit, parseResult, type Scope } from "../src/contracts.ts";
import { ConversationMetaDoc } from "../src/conversation-directory.ts";
import { openRuntime } from "../src/node.ts";
import { deterministicModels, openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";

async function write(directory: string, scope: Scope, model: PiMessage[]) {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, scope.workspaceId, "workspace.sqlite")),
		{
			models: deterministicModels(),
			registry: createRegistry(),
		},
		context,
	);
	try {
		const metadata = (await harness.snapshot(ConversationMetaDoc, scope.conversationId, context))?.value;
		assert.ok(metadata);
		const conversation = await harness.conversation(metadata.durableId as ConversationId, context);
		assert.ok(conversation);
		const result = await (
			await conversation.submit({ type: "write", entry: { kind: "search.fixture", model } }, context)
		).wait(context);
		assert.equal(result.status, "done");
		assert.ok("entry" in result);
		return model.map((_, index) => `${result.entry}_${index}`);
	} finally {
		await harness.close(context);
	}
}
async function refresh(client: AppClient) {
	let cursor: string | undefined;
	for (let step = 0; step < 1000; step++) {
		const status = parseResult(
			"refreshConversationSearch",
			await client.call("refreshConversationSearch", cursor ? { cursor } : {}),
		);
		if (status.nextCursor === null) {
			assert.equal(status.state, "ready");
			return;
		}
		cursor = status.nextCursor;
	}
	assert.fail("Index did not finish");
}
async function search(client: AppClient, query: string) {
	let cursor: string | undefined;
	const hits: ConversationSearchHit[] = [];
	const seen = new Set<string>();
	for (let step = 0; step < 1000; step++) {
		const page = parseResult(
			"searchConversations",
			await client.call("searchConversations", { query, ...(cursor ? { cursor } : {}) }),
		);
		hits.push(...page.items);
		if (page.nextCursor === null) return hits;
		assert.equal(seen.has(page.nextCursor), false);
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	assert.fail("Query did not finish");
}

test("global persisted message search and old-match hydration never open a Harness, including text beyond previews", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-search-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "closed", name: "Collapsed project" });
		await runtime.call("createWorkspace", { workspaceId: "unloaded", name: "Unloaded project" });
		const first = await runtime.call("createConversation", {
			workspaceId: "closed",
			requestId: "first",
			title: "Title-only needle",
		});
		const second = await runtime.call("createConversation", {
			workspaceId: "unloaded",
			requestId: "second",
			title: "Other",
		});
		await runtime.close();
		const large = `${"a".repeat(4090)}😀 NeEdLe 中文 ${"z".repeat(170000)}`;
		const model: PiMessage[] = [
			{ role: "user", content: large, timestamp: 0 },
			...Array.from({ length: 80 }, (_, i) => fauxAssistantMessage(`needle response ${i}`)),
			{
				role: "toolResult",
				toolCallId: "secret",
				toolName: "secret",
				content: [{ type: "text", text: "tool-only-private" }],
				isError: false,
				timestamp: 0,
			},
		];
		const ids = await write(directory, first, model);
		await write(directory, second, [{ role: "user", content: "needle in unloaded project", timestamp: 0 }]);
		runtime = await openRuntime(directory, {
			models: createModels(),
			resume: true,
			catalogFailpoint: async () => {
				throw new Error("Search opened execution");
			},
		});
		assert.equal((await runtime.call("searchConversations", { query: "needle" })).index.state, "building");
		await refresh(runtime);
		const hits = await search(runtime, "needle");
		assert.equal(hits.length, 83);
		assert.equal(hits.filter((hit) => hit.conversationId === second.conversationId).length, 1);
		assert.deepEqual(await search(runtime, "tool-only-private"), []);
		const hit = hits.find((item) => item.kind === "message" && item.messageId === ids[0]);
		assert.ok(hit?.kind === "message");
		assert.equal(hit.matchStart, large.indexOf("NeEdLe"));
		assert.equal(hit.snippet.slice(hit.matchStart - hit.snippetOffset, hit.matchEnd - hit.snippetOffset), "NeEdLe");
		const window = parseResult(
			"getHistoryAroundMatch",
			await runtime
				.call("getHistoryAroundMatch", {
					workspaceId: first.workspaceId,
					conversationId: first.conversationId,
					locator: hit.locator,
				})
				.catch((error) => {
					throw error;
				}),
		);
		assert.equal(window.target.messageId, ids[0]);
		assert.equal(
			window.target.text.slice(window.matchStart - window.target.offset, window.matchEnd - window.target.offset),
			"NeEdLe",
		);
		assert.ok(window.newerCursor);
		const newer = parseResult(
			"getHistoryAroundMatch",
			await runtime.call("getHistoryAroundMatch", {
				workspaceId: first.workspaceId,
				conversationId: first.conversationId,
				locator: hit.locator,
				cursor: window.newerCursor,
			}),
		);
		assert.equal(
			new Set([...window.messages, ...newer.messages].map((message) => message.id)).size,
			window.messages.length + newer.messages.length,
		);
		await assert.rejects(
			runtime.call("getHistoryAroundMatch", {
				workspaceId: second.workspaceId,
				conversationId: second.conversationId,
				locator: hit.locator,
			}),
			{ code: "INVALID_REQUEST" },
		);
		const page = await runtime.call("searchConversations", { query: "needle" });
		assert.ok(page.nextCursor);
		await assert.rejects(runtime.call("searchConversations", { query: "different", cursor: page.nextCursor }), {
			code: "INVALID_REQUEST",
		});
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("partial index resumes on restart; rename/archive never leak old cached results and restored sources refresh", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-search-resume-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "old name",
		});
		const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		await runtime.close();
		await write(directory, scope, [{ role: "user", content: `${"a".repeat(190000)}late-match`, timestamp: 0 }]);
		runtime = await openTestRuntime(directory);
		const partial = await runtime.call("refreshConversationSearch", {});
		assert.ok(partial.nextCursor);
		assert.equal(partial.state, "building");
		await runtime.close();
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("refreshConversationSearch", { cursor: partial.nextCursor }), {
			code: "CURSOR_STALE",
		});
		await refresh(runtime);
		assert.equal((await search(runtime, "late-match")).length, 1);
		const renamed = await runtime.call("renameConversation", {
			...scope,
			requestId: "rename",
			expectedRevision: 1,
			title: "new name",
		});
		assert.deepEqual(await search(runtime, "old name"), []);
		await refresh(runtime);
		assert.equal((await search(runtime, "new name")).length, 1);
		const archived = await runtime.call("archiveConversation", {
			...scope,
			requestId: "archive",
			expectedRevision: renamed.revision,
		});
		assert.deepEqual(await search(runtime, "late-match"), []);
		await runtime.call("restoreConversation", {
			...scope,
			requestId: "restore",
			expectedRevision: archived.revision,
		});
		await refresh(runtime);
		assert.equal((await search(runtime, "late-match")).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("escaped Unicode query and long identity locators round-trip through HTTP with exact offsets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-search-wire-"));
	let runtime = await openTestRuntime(directory);
	try {
		const workspaceId = "w".repeat(128);
		await runtime.call("createWorkspace", { workspaceId, name: "中文" });
		const conversation = await runtime.call("createConversation", {
			workspaceId,
			requestId: "create",
			title: "Wire",
		});
		const scope = { workspaceId, conversationId: conversation.conversationId };
		await runtime.close();
		await write(directory, scope, [
			{ role: "user", content: `😀${"\0".repeat(256)}end`, timestamp: 0 },
			...Array.from({ length: 40 }, () => fauxAssistantMessage("界".repeat(256))),
		]);
		runtime = await openTestRuntime(directory);
		const server = await serveLoopback(runtime, { origin: "http://localhost:3000" });
		const client = createHttpClient({ url: server.url, token: server.token, origin: "http://localhost:3000" });
		try {
			await refresh(client);
			for (const query of ["\0".repeat(256), "界".repeat(256)]) {
				const hits = await search(client, query);
				const hit = hits[0];
				assert.ok(hit?.kind === "message");
				assert.equal(hit.matchEnd - hit.matchStart, 256);
				const result = await client.call("getHistoryAroundMatch", { ...scope, locator: hit.locator });
				assert.ok(result.newerCursor);
				await client.call("getHistoryAroundMatch", { ...scope, locator: hit.locator, cursor: result.newerCursor });
			}
		} finally {
			await server.close();
		}
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
