import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message as PiMessage } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	type AppClient,
	type Frame,
	type HistoryPage,
	LIMITS,
	type Message,
	type MessageTextChunk,
	type Scope,
} from "../src/contracts.ts";
import { ConversationMetaDoc } from "../src/conversation-directory.ts";
import { openRuntime as openNodeRuntime } from "../src/node.ts";
import { deterministicModels, openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";

// Read application metadata through PI's public document API, without private handles.
async function editHistory(
	directory: string,
	scope: Scope,
	edit: (conversation: Conversation, harness: Harness) => Promise<void>,
) {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite")),
		{
			models: deterministicModels(100000),
			registry: createRegistry(),
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		},
		context,
	);
	try {
		const metadata = (await harness.snapshot(ConversationMetaDoc, scope.conversationId, context))?.value;
		assert.ok(metadata);
		const conversation = await harness.conversation(metadata.durableId as ConversationId, context);
		assert.ok(conversation);
		await edit(conversation, harness);
	} finally {
		await harness.close(context);
	}
}
async function write(conversation: Conversation, model: PiMessage[]): Promise<string[]> {
	const submission = await conversation.submit({ type: "write", entry: { kind: "history.fixture", model } }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done");
	assert.ok("entry" in settled);
	return model.map((_, index) => `${settled.entry}_${index}`);
}
async function allHistory(client: AppClient, scope: Scope): Promise<Message[]> {
	const snapshot = await client.call("snapshot", scope);
	let messages = snapshot.messages;
	let cursor = snapshot.historyCursor;
	const seen = new Set<string>();
	while (cursor !== null) {
		assert.equal(seen.has(cursor), false, "continuation must advance");
		seen.add(cursor);
		const page: HistoryPage = await client.call("getHistory", { ...scope, cursor });
		assert.ok(page.messages.length <= LIMITS.historyMessages);
		messages = [...page.messages, ...messages];
		cursor = page.nextCursor;
	}
	assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
	return messages;
}
test(
	"public PI history keeps over 128 interrupted and multi-model messages across restart, compaction and reset",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-history-"));
		let runtime = await openTestRuntime(directory);
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "History" });
			const created = await runtime.call("createConversation", {
				requestId: "create-1",
				workspaceId: "work",
				title: "Many",
			});
			const scope = { workspaceId: created.workspaceId, conversationId: created.conversationId };
			const expected: { id: string; text: string; interrupted?: true }[] = [];
			await runtime.close();
			await editHistory(directory, scope, async (conversation) => {
				for (let index = 0; index < 45; index++) {
					const model: PiMessage[] = [
						{ role: "user", content: `question ${index}`, timestamp: index },
						fauxAssistantMessage(`interrupted ${index}`, { stopReason: "aborted" }),
						fauxAssistantMessage(`answer ${index}`),
					];
					const ids = await write(conversation, model);
					expected.push(
						{ id: ids[0], text: `question ${index}` },
						{ id: ids[1], text: `interrupted ${index}`, interrupted: true },
						{ id: ids[2], text: `answer ${index}` },
					);
				}
			});
			runtime = await openTestRuntime(directory);
			const first = await runtime.call("snapshot", scope);
			assert.equal(first.messages.length, LIMITS.historyMessages);
			assert.ok(first.historyCursor);
			const check = async () => {
				const messages = await allHistory(runtime, scope);
				assert.deepEqual(
					messages
						.filter((message) => expected.some((item) => item.id === message.id))
						.map(({ id, text, interrupted }) => ({ id, text, ...(interrupted ? { interrupted } : {}) })),
					expected,
				);
			};
			await check();
			await assert.rejects(runtime.call("getHistory", { ...scope, cursor: "not-a-cursor" }), {
				code: "INVALID_REQUEST",
			});
			const other = await runtime.call("createConversation", {
				requestId: "create-2",
				workspaceId: "work",
				title: "Other",
			});
			await assert.rejects(
				runtime.call("getHistory", {
					workspaceId: other.workspaceId,
					conversationId: other.conversationId,
					cursor: first.historyCursor,
				}),
				{ code: "INVALID_REQUEST" },
			);
			await assert.rejects(
				runtime.call("getMessageText", {
					workspaceId: other.workspaceId,
					conversationId: other.conversationId,
					messageId: expected[0].id,
					offset: 0,
				}),
				{ code: "NOT_FOUND" },
			);
			await runtime.close();
			await editHistory(directory, scope, async (conversation, harness) => {
				const result = await harness.waitForTask(await conversation.compact(undefined, context), context);
				assert.equal(result.state.outcome.status, "completed");
				assert.ok(
					(await conversation.context(context)).entries.length < 45,
					"compaction must actually reduce active context",
				);
			});
			runtime = await openTestRuntime(directory);
			await check();
			await runtime.close();
			await editHistory(directory, scope, async (conversation) => {
				await conversation.reset(undefined, context);
				assert.ok((await conversation.context(context)).entries.length < 45);
			});
			runtime = await openTestRuntime(directory);
			await check();
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
test(
	"empty history pages retain continuation and an old cursor excludes appended entries",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-empty-history-"));
		let runtime = await openTestRuntime(directory);
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "History" });
			const created = await runtime.call("createConversation", {
				requestId: "create-3",
				workspaceId: "work",
				title: "Sparse",
			});
			const scope = { workspaceId: created.workspaceId, conversationId: created.conversationId };
			await runtime.close();
			await editHistory(directory, scope, async (conversation) => {
				await write(conversation, [{ role: "user", content: "oldest", timestamp: 0 }]);
				for (let i = 0; i < LIMITS.historyScanEntries * 2 + 1; i++) await write(conversation, []);
				await write(
					conversation,
					Array.from({ length: LIMITS.historyMessages }, (_, i) => ({
						role: "user",
						content: `new ${i}`,
						timestamp: i,
					})),
				);
			});
			runtime = await openTestRuntime(directory);
			const snapshot = await runtime.call("snapshot", scope);
			assert.ok(snapshot.historyCursor);
			const empty = await runtime.call("getHistory", { ...scope, cursor: snapshot.historyCursor });
			assert.deepEqual(empty.messages, []);
			assert.ok(empty.nextCursor);
			await runtime.close();
			await editHistory(directory, scope, async (conversation) => {
				await write(conversation, [{ role: "user", content: "appended", timestamp: 999 }]);
			});
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("getHistory", { ...scope, cursor: snapshot.historyCursor }), empty);
			let cursor: string | null = empty.nextCursor;
			const texts: string[] = [];
			while (cursor !== null) {
				const page: HistoryPage = await runtime.call("getHistory", { ...scope, cursor });
				texts.unshift(...page.messages.map((message) => message.text));
				cursor = page.nextCursor;
			}
			assert.deepEqual(texts, ["oldest"]);
			assert.equal((await runtime.call("snapshot", scope)).messages.at(-1)?.text, "appended");
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
test(
	"long committed and live text stays bounded over HTTP and reconstructs exact Unicode and escapes",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-long-history-"));
		let runtime = await openTestRuntime(directory);
		const text = `a${'😀中文"\\\n\t\u0000'.repeat(100000)}`;
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "History" });
			const created = await runtime.call("createConversation", {
				requestId: "create-4",
				workspaceId: "work",
				title: "Long",
			});
			const scope = { workspaceId: created.workspaceId, conversationId: created.conversationId };
			await runtime.close();
			await editHistory(directory, scope, async (conversation) => {
				await write(conversation, [fauxAssistantMessage(text)]);
				await conversation.commit(async (tx) => {
					const live = await tx.doc(LiveDoc, conversation.id);
					live.generation = {
						attempt: 1,
						message: {
							role: "assistant",
							api: "faux",
							provider: "faux",
							model: "faux-1",
							usage: fauxAssistantMessage("").usage,
							stopReason: "stop",
							timestamp: 0,
							content: [{ type: "text", text }],
						},
					};
				}, context);
			});
			runtime = await openTestRuntime(directory);
			const origin = "http://127.0.0.1:4000";
			const server = await serveLoopback(runtime, { origin });
			try {
				const client = createHttpClient({ ...server, origin });
				const snapshot = await client.call("snapshot", scope);
				assert.equal(snapshot.partialLength, text.length);
				assert.equal(snapshot.partialTruncated, true);
				assert.ok(snapshot.partial.length <= LIMITS.partialPreview);
				assert.equal(snapshot.messages[0].textLength, text.length);
				assert.equal(snapshot.messages[0].truncated, true);
				const messageId = snapshot.messages[0].id;
				let offset: number | null = 0;
				let reconstructed = "";
				while (offset !== null) {
					const chunk: MessageTextChunk = await client.call("getMessageText", { ...scope, messageId, offset });
					assert.equal(chunk.offset, offset);
					assert.equal(chunk.textLength, text.length);
					assert.ok(chunk.text.length <= LIMITS.textChunk);
					assert.equal(chunk.text.isWellFormed(), true);
					assert.ok(Buffer.byteLength(JSON.stringify({ result: chunk })) <= LIMITS.frameBytes);
					reconstructed += chunk.text;
					offset = chunk.nextOffset;
				}
				assert.equal(reconstructed, text);
				const normalized = await client.call("getMessageText", { ...scope, messageId, offset: 2 });
				assert.equal(normalized.offset, 1);
				assert.ok(normalized.text.startsWith("😀"));
				const end = await client.call("getMessageText", { ...scope, messageId, offset: text.length });
				assert.equal(end.text, "");
				assert.equal(end.nextOffset, null);
				const firstFrame = Promise.withResolvers<Frame>();
				const watcher = await client.observe(scope, (frame) => {
					firstFrame.resolve(frame);
				});
				const frame = await firstFrame.promise;
				assert.deepEqual(frame.snapshot, snapshot);
				assert.ok(Buffer.byteLength(`data: ${JSON.stringify({ kind: "frame", frame })}\n\n`) <= LIMITS.frameBytes);
				await watcher.dispose();
			} finally {
				await server.close();
			}
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"a genuine completed long PI answer has a bounded receipt and complete persisted chunks",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-long-receipt-"));
		const answer = '😀中文"\\\n\u0000'.repeat(100000);
		const faux = fauxProvider({
			tokensPerSecond: 100000,
			tokenSize: { min: 65536, max: 65536 },
			models: [{ id: "faux-1", contextWindow: 2000000, maxTokens: 2000000 }],
		});
		faux.setResponses([fauxAssistantMessage(answer)]);
		const models = createModels();
		models.setProvider(faux.provider);
		let runtime = await openNodeRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" } });
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Long receipt" });
			const created = await runtime.call("createConversation", {
				requestId: "create-5",
				workspaceId: "work",
				title: "Long answer",
			});
			const scope = { workspaceId: created.workspaceId, conversationId: created.conversationId };
			await runtime.call("submit", { ...scope, requestId: "long", text: "Reply with the fixture" });
			let receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "long" });
			const deadline = Date.now() + 10000;
			while (receipt?.execution !== "done" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "long" });
			}
			assert.equal(receipt?.execution, "done");
			assert.ok(receipt);
			assert.equal(receipt.answerLength, answer.length);
			assert.equal(receipt.answerTruncated, true);
			assert.ok(receipt.answer && answer.startsWith(receipt.answer));
			assert.ok(receipt.answer.length <= LIMITS.messagePreview);
			assert.ok(Buffer.byteLength(JSON.stringify({ result: receipt })) < LIMITS.frameBytes);
			const completed = receipt;
			await runtime.close();
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("getReceipt", { workspaceId: "work", requestId: "long" }), completed);
			const snapshot = await runtime.call("snapshot", scope);
			const message = snapshot.messages.find((item) => item.id === `${receipt.answerEntryId}_0`);
			assert.ok(message);
			assert.equal(message.text, receipt.answer);
			let offset: number | null = 0;
			let reconstructed = "";
			while (offset !== null) {
				const chunk: MessageTextChunk = await runtime.call("getMessageText", {
					...scope,
					messageId: message.id,
					offset,
				});
				reconstructed += chunk.text;
				offset = chunk.nextOffset;
			}
			assert.equal(reconstructed, answer);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
