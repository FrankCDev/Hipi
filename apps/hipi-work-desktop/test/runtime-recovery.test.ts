import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkRuntime } from "@hipi/work-runtime";
import {
	LIMITS,
	type MessageTextChunk,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { decode, record } from "../src/ipc/protocol.ts";
import { HostConnection } from "../src/runtime/connection.ts";
import { createRuntimeRouter } from "../src/runtime/router.ts";

function connection(runtime: WorkRuntime, generation: string) {
	let dropReply = false;
	const tasks = new Set<Promise<void>>();
	const host = new HostConnection(generation, (raw) => {
		const task = router.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => host.close());
	});
	const router = createRuntimeRouter(runtime, generation, (raw) => {
		if (dropReply && decode(raw).kind === "result") {
			dropReply = false;
			host.close();
		} else host.receive(raw);
	});
	return {
		host,
		dropNextReply: () => {
			dropReply = true;
		},
		async call<M extends Method>(method: M, params: Params<M>, expectedStoreId?: string) {
			const response = record(await host.call({ version: PROTOCOL_VERSION, method, params, expectedStoreId }).result);
			assert.equal(response.ok, true);
			return parseResult(method, response.result);
		},
		async close() {
			host.close();
			await Promise.all([...tasks]);
			await router.shutdown();
		},
	};
}

test("real PI receipt survives lost desktop reply and runtime reopen without resubmit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-recovery-"));
	let active = connection(await openTestRuntime(directory, { tokensPerSecond: 10000 }), "first");
	try {
		const { storeId } = await active.call("handshake", {});
		await active.call("createWorkspace", { workspaceId: "work", name: "Desktop" }, storeId);
		const conversation = await active.call(
			"createConversation",
			{ requestId: "create-1", workspaceId: "work", title: "Recovery" },
			storeId,
		);
		active.dropNextReply();
		const response = await active.host.call({
			version: PROTOCOL_VERSION,
			method: "submit",
			expectedStoreId: storeId,
			params: {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: "original",
				text: "Keep this accepted intent",
			},
		}).result;
		assert.deepEqual(response, { ok: false, error: "CLOSED" });
		await active.close();
		active = connection(await openTestRuntime(directory, { resume: true, tokensPerSecond: 10000 }), "second");
		assert.equal((await active.call("handshake", {})).storeId, storeId);
		const receipt = await active.call("getReceipt", { workspaceId: "work", requestId: "original" }, storeId);
		assert.equal(receipt?.requestId, "original");
		const snapshot = await active.call(
			"snapshot",
			{ workspaceId: "work", conversationId: conversation.conversationId },
			storeId,
		);
		assert.equal(
			snapshot.messages.filter((message) => message.role === "user" && message.text === "Keep this accepted intent")
				.length,
			1,
		);
		const rejected = await active.host.call({
			version: PROTOCOL_VERSION,
			method: "createWorkspace",
			expectedStoreId: "other",
			params: { workspaceId: "wrong", name: "Wrong" },
		}).result;
		assert.deepEqual(rejected, { ok: false, error: "STORE_MISMATCH" });
	} finally {
		await active.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("desktop routers preserve bounded history and exact Unicode text after PI reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-history-"));
	let active = connection(await openTestRuntime(directory, { tokensPerSecond: 10000 }), "first");
	try {
		const { storeId } = await active.call("handshake", {});
		await active.call("createWorkspace", { workspaceId: "work", name: "Desktop" }, storeId);
		const conversation = await active.call(
			"createConversation",
			{ requestId: "create-2", workspaceId: "work", title: "History" },
			storeId,
		);
		const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		const text = '中文😀\\"\n'.repeat(400);
		assert.ok(text.length > LIMITS.messagePreview && text.length <= LIMITS.text);
		await active.call("submit", { ...scope, requestId: "long-input", text }, storeId);
		await active.close();
		active = connection(await openTestRuntime(directory, { resume: true, tokensPerSecond: 10000 }), "second");
		assert.equal((await active.call("handshake", {})).storeId, storeId);
		const page = await active.call("getHistory", scope, storeId);
		assert.ok(page.messages.length <= LIMITS.historyMessages);
		const message = page.messages.find((item) => item.role === "user");
		assert.ok(message);
		assert.equal(message.truncated, true);
		assert.equal(message.textLength, text.length);
		assert.ok(message.text.length <= LIMITS.messagePreview);
		assert.ok(text.startsWith(message.text));
		let reconstructed = "";
		let offset = 0;
		for (;;) {
			const chunk: MessageTextChunk = await active.call(
				"getMessageText",
				{ ...scope, messageId: message.id, offset },
				storeId,
			);
			assert.equal(chunk.offset, offset);
			assert.equal(chunk.textLength, text.length);
			assert.ok(chunk.text.length <= LIMITS.textChunk);
			reconstructed += chunk.text;
			if (chunk.nextOffset === null) break;
			assert.ok(chunk.nextOffset > offset);
			offset = chunk.nextOffset;
		}
		assert.equal(reconstructed, text);
		const other = await active.call(
			"createConversation",
			{ requestId: "create-3", workspaceId: "work", title: "Other" },
			storeId,
		);
		const rejected = await active.host.call({
			version: PROTOCOL_VERSION,
			method: "getMessageText",
			expectedStoreId: storeId,
			params: { workspaceId: "work", conversationId: other.conversationId, messageId: message.id, offset: 0 },
		}).result;
		assert.deepEqual(rejected, { ok: false, error: "NOT_FOUND" });
	} finally {
		await active.close();
		await rm(directory, { recursive: true, force: true });
	}
});
