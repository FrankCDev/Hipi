import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AppClient,
	type Conversation,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Scope,
} from "../src/contracts.ts";
import { openRuntime } from "../src/node.ts";
import { openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";

async function create(client: AppClient, workspaceId = "work", requestId = "create"): Promise<Conversation> {
	await client.call("createWorkspace", { workspaceId, name: workspaceId });
	return client.call("createConversation", { workspaceId, requestId, title: requestId });
}
function scope(conversation: Scope): Scope {
	return { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
}
function pin(
	conversation: Scope,
	requestId = "pin",
	expectedPresentationRevision = 0,
): Params<"setConversationPinned"> {
	return { ...scope(conversation), requestId, expectedPresentationRevision, pinned: true };
}

test("presentation protocol validates exact scope, intent, revision and bounded canonical results", () => {
	const input = pin({ workspaceId: "work", conversationId: "one" });
	const request = (params: unknown) =>
		parseRequest({ version: PROTOCOL_VERSION, method: "setConversationPinned", params });
	assert.deepEqual(request(input).params, input);
	for (const patch of [
		{ workspaceId: "../work" },
		{ requestId: "" },
		{ expectedPresentationRevision: -1 },
		{ expectedPresentationRevision: 1.5 },
		{ expectedPresentationRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ expectedRevision: 1 },
		{ pinned: "true" },
		{ folder: "/tmp" },
	])
		assert.throws(() => request({ ...input, ...patch }), { code: "INVALID_REQUEST" });
	const presentation = { ...scope(input), revision: 1, pinned: true };
	const result = { method: "setConversationPinned", params: input, result: presentation };
	assert.deepEqual(parseResult("getPresentationCommandResult", result), result);
	for (const patch of [{ pinned: false }, { revision: 3 }, { conversationId: "foreign" }, { revision: 0 }])
		assert.throws(() =>
			parseResult("getPresentationCommandResult", { ...result, result: { ...presentation, ...patch } }),
		);
	const conversation = { ...scope(input), title: "One", revision: 1, createdAt: null, archivedAt: null };
	const entry = { conversation, presentation };
	assert.throws(() => parseResult("listPinnedConversations", { items: [entry, entry], nextCursor: null }));
	assert.throws(() =>
		parseResult("listPinnedConversations", {
			items: [{ ...entry, conversation: { ...conversation, archivedAt: 1 } }],
			nextCursor: null,
		}),
	);
	assert.throws(() =>
		parseResult("listPinnedConversations", { items: Array.from({ length: 51 }, () => entry), nextCursor: null }),
	);
});

test("pins append across workspaces, no-op and duplicate receipts never reorder, and current truth survives restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-"));
	let runtime = await openTestRuntime(directory);
	try {
		const first = await create(runtime, "one");
		const second = await create(runtime, "two");
		assert.deepEqual(await runtime.call("getConversationPresentation", scope(first)), {
			...scope(first),
			revision: 0,
			pinned: false,
		});
		const input = pin(first);
		const firstResult = await runtime.call("setConversationPinned", input);
		await runtime.call("setConversationPinned", pin(second, "pin-two"));
		assert.deepEqual(
			await runtime.call("setConversationPinned", {
				...input,
				requestId: "same-value",
				expectedPresentationRevision: 1,
			}),
			firstResult,
		);
		assert.deepEqual(
			(await runtime.call("listPinnedConversations", {})).items.map((item) => item.conversation),
			[first, second],
		);
		await runtime.call("setConversationPinned", {
			...input,
			requestId: "unpin",
			expectedPresentationRevision: 1,
			pinned: false,
		});
		await runtime.call("setConversationPinned", { ...input, requestId: "repin", expectedPresentationRevision: 2 });
		assert.deepEqual(await runtime.call("setConversationPinned", input), firstResult);
		assert.deepEqual(
			(await runtime.call("listPinnedConversations", {})).items.map((item) => item.conversation),
			[second, first],
		);
		const originalConversation = await runtime.call("getConversation", scope(first));
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), {
			method: "setConversationPinned",
			params: input,
			result: firstResult,
		});
		assert.deepEqual(await runtime.call("getConversationPresentation", scope(first)), {
			...scope(first),
			revision: 3,
			pinned: true,
		});
		assert.deepEqual(await runtime.call("getConversation", scope(first)), originalConversation);
		await assert.rejects(runtime.call("setConversationPinned", { ...input, pinned: false }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		await assert.rejects(runtime.call("setConversationPinned", { ...pin(second), requestId: "pin" }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("catalog pin queries and mutations do not acquire a workspace owner or resume a pending submission", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-owner-"));
	let runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("paused");
		},
	});
	try {
		const conversation = await create(runtime);
		await assert.rejects(
			runtime.call("submit", { ...scope(conversation), requestId: "pending", text: "Do not execute" }),
			/paused/,
		);
		await runtime.close();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		const lock = new DatabaseSync(join(directory, "work", "owner.sqlite"));
		try {
			lock.exec("BEGIN EXCLUSIVE");
			await runtime.call("setConversationPinned", pin(conversation));
			assert.equal((await runtime.call("getConversationPresentation", scope(conversation))).pinned, true);
			assert.equal((await runtime.call("listPinnedConversations", {})).items.length, 1);
			assert.ok(await runtime.call("getPresentationCommandResult", { requestId: "pin" }));
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(faux.state.callCount, 0);
		} finally {
			lock.close();
		}
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing/foreign/archived scopes and stale revisions reject without admitting a receipt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-invalid-"));
	const runtime = await openTestRuntime(directory);
	try {
		const conversation = await create(runtime);
		await create(runtime, "other");
		for (const target of [
			{ workspaceId: "missing", conversationId: "one" },
			{ ...scope(conversation), workspaceId: "other" },
		]) {
			await assert.rejects(runtime.call("setConversationPinned", pin(target, "missing")), { code: "NOT_FOUND" });
			assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "missing" }), null);
		}
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				expectedStoreId: "foreign",
				method: "setConversationPinned",
				params: pin(conversation),
			}),
			{ code: "STORE_MISMATCH" },
		);
		await assert.rejects(runtime.call("setConversationPinned", pin(conversation, "stale", 1)), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "stale" }), null);
		await runtime.call("archiveConversation", { ...scope(conversation), requestId: "archive", expectedRevision: 1 });
		await assert.rejects(runtime.call("setConversationPinned", pin(conversation, "archived")), {
			code: "CONVERSATION_ARCHIVED",
		});
		assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "archived" }), null);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("lost pin reply and caller cancellation retain one atomic receipt, including concurrent duplicates", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-receipt-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = true;
	let runtime = await openTestRuntime(directory, {
		presentationFailpoint: async (point) => {
			if (point === "after_commit" && held) {
				entered.resolve();
				await release.promise;
				throw new Error("lost reply");
			}
		},
	});
	try {
		const conversation = await create(runtime);
		const input = pin(conversation);
		const cancel = new AbortController();
		const pending = runtime.call("setConversationPinned", input, cancel.signal);
		await entered.promise;
		cancel.abort(new Error("stop waiting"));
		await assert.rejects(pending, /stop waiting/);
		const receipt = await runtime.call("getPresentationCommandResult", { requestId: "pin" });
		assert.ok(receipt);
		assert.deepEqual(
			await Promise.all(Array.from({ length: 8 }, () => runtime.call("setConversationPinned", input))),
			Array.from({ length: 8 }, () => receipt.result),
		);
		held = false;
		await runtime.call("setConversationPinned", {
			...input,
			requestId: "unpin",
			expectedPresentationRevision: 1,
			pinned: false,
		});
		release.resolve();
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), receipt);
		assert.equal((await runtime.call("getConversationPresentation", scope(conversation))).pinned, false);
		assert.deepEqual(await runtime.call("listPinnedConversations", {}), { items: [], nextCursor: null });
	} finally {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("SQLite journal failure rolls back presentation state and ordering in the same transaction", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-rollback-"));
	const runtime = await openTestRuntime(directory);
	const db = new DatabaseSync(join(directory, "catalog.sqlite"));
	try {
		const conversation = await create(runtime);
		db.exec(
			"CREATE TRIGGER fail_pin_journal BEFORE INSERT ON presentation_commands BEGIN SELECT RAISE(ABORT,'journal failure'); END",
		);
		await assert.rejects(runtime.call("setConversationPinned", pin(conversation)), /journal failure/);
		assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), null);
		assert.deepEqual(await runtime.call("getConversationPresentation", scope(conversation)), {
			...scope(conversation),
			revision: 0,
			pinned: false,
		});
		assert.equal(db.prepare("SELECT generation FROM presentation_state").get()?.generation, 0);
		db.exec("DROP TRIGGER fail_pin_journal");
		assert.equal((await runtime.call("setConversationPinned", pin(conversation))).revision, 1);
	} finally {
		db.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("interrupted archive cleanup is fenced before Restore, and old archive replay never removes a newer re-pin", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-archive-"));
	let runtime = await openTestRuntime(directory, {
		presentationFailpoint: (point) => {
			if (point === "before_archive_cleanup") throw new Error("cleanup interrupted");
		},
	});
	try {
		const conversation = await create(runtime);
		await runtime.call("setConversationPinned", pin(conversation));
		const archive = { ...scope(conversation), requestId: "archive", expectedRevision: 1 };
		await assert.rejects(runtime.call("archiveConversation", archive), /cleanup interrupted/);
		const immutable = await runtime.call("getConversationCommandResult", {
			workspaceId: "work",
			requestId: "archive",
		});
		assert.equal(immutable?.result.revision, 2);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		const restored = await runtime.call("restoreConversation", {
			...scope(conversation),
			requestId: "restore",
			expectedRevision: 2,
		});
		assert.equal(restored.revision, 3);
		assert.deepEqual(await runtime.call("getConversationPresentation", scope(conversation)), {
			...scope(conversation),
			revision: 2,
			pinned: false,
		});
		await runtime.call("setConversationPinned", pin(conversation, "repin", 2));
		assert.deepEqual(await runtime.call("archiveConversation", archive), immutable?.result);
		assert.equal((await runtime.call("getConversationPresentation", scope(conversation))).pinned, true);
		assert.equal((await runtime.call("listPinnedConversations", {})).items[0].conversation.archivedAt, null);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("an existence read that races Archive and Restore cannot admit an obsolete pin", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-race-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = await openTestRuntime(directory, {
		presentationFailpoint: async (point) => {
			if (point === "after_read") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	try {
		const conversation = await create(runtime);
		const pinning = runtime.call("setConversationPinned", pin(conversation));
		await entered.promise;
		await runtime.call("archiveConversation", { ...scope(conversation), requestId: "archive", expectedRevision: 1 });
		await runtime.call("restoreConversation", { ...scope(conversation), requestId: "restore", expectedRevision: 2 });
		const rejected = assert.rejects(pinning, { code: "CONVERSATION_ARCHIVED" });
		release.resolve();
		await rejected;
		assert.equal(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), null);
		assert.equal((await runtime.call("getConversationPresentation", scope(conversation))).pinned, false);
	} finally {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("catalog reads remove pending archive cleanup after restart, while the first pin receipt stays immutable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-cleanup-"));
	let runtime = await openTestRuntime(directory, {
		presentationFailpoint: (point) => {
			if (point === "before_archive_cleanup") throw new Error("cleanup interrupted");
		},
	});
	try {
		const conversation = await create(runtime);
		const input = pin(conversation);
		const pinned = await runtime.call("setConversationPinned", input);
		await assert.rejects(
			runtime.call("archiveConversation", { ...scope(conversation), requestId: "archive", expectedRevision: 1 }),
			/cleanup interrupted/,
		);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("listPinnedConversations", {}), { items: [], nextCursor: null });
		assert.deepEqual(await runtime.call("getConversationPresentation", scope(conversation)), {
			...scope(conversation),
			revision: 2,
			pinned: false,
		});
		assert.deepEqual(await runtime.call("getPresentationCommandResult", { requestId: "pin" }), {
			method: "setConversationPinned",
			params: input,
			result: pinned,
		});
		await runtime.call("restoreConversation", { ...scope(conversation), requestId: "restore", expectedRevision: 2 });
		assert.deepEqual(await runtime.call("listPinnedConversations", {}), { items: [], nextCursor: null });
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a PI archive commit with a lost reply still records its durable cleanup fence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-directory-reply-"));
	let interrupt = false;
	const runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (interrupt && point === "after_directory_commit") throw new Error("directory reply lost");
		},
	});
	try {
		const conversation = await create(runtime);
		await runtime.call("setConversationPinned", pin(conversation));
		interrupt = true;
		await assert.rejects(
			runtime.call("archiveConversation", { ...scope(conversation), requestId: "archive", expectedRevision: 1 }),
			/directory reply lost/,
		);
		const database = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
		try {
			const value = database.prepare("SELECT pin_ordinal,archived_revision FROM conversation_presentations").get();
			assert.equal(value?.pin_ordinal, null);
			assert.equal(value?.archived_revision, 2);
		} finally {
			database.close();
		}
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("pin pages are bounded and store/generation scoped without invalidating conversation-directory cursors", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-presentation-pages-"));
	const runtime = await openTestRuntime(directory);
	try {
		const conversations: Conversation[] = [];
		for (let index = 0; index < 52; index++) conversations.push(await create(runtime, "work", `create-${index}`));
		const directoryPage = await runtime.call("listConversations", { workspaceId: "work" });
		assert.ok(directoryPage.nextCursor);
		for (const [index, conversation] of conversations.entries())
			await runtime.call("setConversationPinned", pin(conversation, `pin-${index}`));
		const first = await runtime.call("listPinnedConversations", {});
		assert.equal(first.items.length, 50);
		assert.ok(first.nextCursor);
		const second = await runtime.call("listPinnedConversations", { cursor: first.nextCursor });
		assert.deepEqual(
			second.items.map((item) => item.conversation),
			conversations.slice(50),
		);
		assert.equal(second.nextCursor, null);
		assert.equal(
			(await runtime.call("listConversations", { workspaceId: "work", cursor: directoryPage.nextCursor })).items
				.length,
			2,
		);
		await runtime.call("renameConversation", {
			...scope(conversations[51]),
			requestId: "rename",
			expectedRevision: 1,
			title: "Renamed",
		});
		assert.equal(
			(await runtime.call("listPinnedConversations", { cursor: first.nextCursor })).items[1].conversation.title,
			"Renamed",
		);
		const foreign = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		foreign.storeId = "foreign";
		await assert.rejects(
			runtime.call("listPinnedConversations", {
				cursor: Buffer.from(JSON.stringify(foreign)).toString("base64url"),
			}),
			{ code: "INVALID_REQUEST" },
		);
		await runtime.call("setConversationPinned", { ...pin(conversations[0], "remove", 1), pinned: false });
		await assert.rejects(runtime.call("listPinnedConversations", { cursor: first.nextCursor }), {
			code: "CURSOR_STALE",
		});
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const transport of ["http", "ipc"] as const) {
	test(
		`presentation commands and immutable lookup survive the ${transport} boundary`,
		{ timeout: 20000 },
		async () => {
			const directory = await mkdtemp(join(tmpdir(), `hipi-presentation-${transport}-`));
			const runtime = transport === "http" ? await openTestRuntime(directory) : undefined;
			const origin = "http://127.0.0.1:4000";
			const server = runtime ? await serveLoopback(runtime, { origin }) : undefined;
			const child =
				transport === "ipc"
					? fork(new URL("./transport-runtime-child.ts", import.meta.url), [directory], {
							stdio: ["ignore", "ignore", "inherit", "ipc"],
						})
					: undefined;
			try {
				if (child) assert.equal((await once(child, "message"))[0], "ready");
				const client = child ? createNodeIpcClient(child) : createHttpClient({ ...server!, origin });
				const conversation = await create(client);
				const input = pin(conversation);
				const result = await client.call("setConversationPinned", input);
				assert.deepEqual(await client.call("getPresentationCommandResult", { requestId: "pin" }), {
					method: "setConversationPinned",
					params: input,
					result,
				});
				assert.equal((await client.call("getConversationPresentation", scope(conversation))).pinned, true);
				assert.deepEqual((await client.call("listPinnedConversations", {})).items, [
					{ conversation, presentation: result },
				]);
				if ("close" in client && typeof client.close === "function") client.close();
			} finally {
				if (child && child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}
				await server?.close();
				await runtime?.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
}
