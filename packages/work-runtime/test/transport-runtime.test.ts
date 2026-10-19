import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type LiveState, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorageReadOnly } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppClient, Frame, Scope } from "../src/contracts.ts";
import { openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Transport integration timed out");
}
async function setup(client: AppClient): Promise<Scope> {
	await client.call("createWorkspace", { workspaceId: "work", name: "Test" });
	const created = await client.call("createConversation", {
		requestId: "create-1",
		workspaceId: "work",
		title: "Integration",
	});
	return { workspaceId: created.workspaceId, conversationId: created.conversationId };
}
async function completed(client: AppClient, requestId: string) {
	return until(async () => {
		const receipt = await client.call("getReceipt", { workspaceId: "work", requestId });
		return receipt?.execution === "done" ? receipt : undefined;
	});
}
async function childClient(directory: string, holdPartial = false) {
	const fixture = holdPartial ? "./transport-runtime-partial-child.ts" : "./transport-runtime-child.ts";
	const child = fork(new URL(fixture, import.meta.url), [directory], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Child did not become ready"));
			}, 10000);
			const ready = (value: unknown) => {
				cleanup();
				value === "ready" ? resolve() : reject(new Error("Unexpected child handshake"));
			};
			const failed = () => {
				cleanup();
				reject(new Error("Child failed before ready"));
			};
			const cleanup = () => {
				clearTimeout(timer);
				child.off("message", ready);
				child.off("exit", failed);
				child.off("error", failed);
			};
			child.once("message", ready);
			child.once("exit", failed);
			child.once("error", failed);
		});
		return { child, client: createNodeIpcClient(child) };
	} catch (error) {
		await kill(child);
		throw error;
	}
}
async function kill(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

test("real PI SQLite via HTTP: streamed execution survives cancelWait and reconnect", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-http-runtime-"));
	const runtime = await openTestRuntime(directory, { tokensPerSecond: 200, resume: true });
	const origin = "http://127.0.0.1:4000";
	const server = await serveLoopback(runtime, { origin });
	try {
		const client = createHttpClient({ ...server, origin });
		const scope = await setup(client);
		const frames: Frame[] = [];
		const wait = new AbortController();
		const watcher = await client.observe(
			scope,
			(frame) => {
				frames.push(frame);
			},
			wait.signal,
		);
		const receipt = await client.call("submit", {
			...scope,
			requestId: "http_request",
			text: "Test the real durable path",
		});
		await until(async () => (frames.some((frame) => frame.snapshot.partial.length > 0) ? true : undefined));
		wait.abort();
		await watcher.dispose();
		const count = frames.length;
		const reconnected = createHttpClient({ ...server, origin });
		const final = await completed(reconnected, "http_request");
		assert.equal(final.receiptId, receipt.receiptId);
		assert.match(final.answer ?? "", /deterministic test answer/);
		assert.equal(frames.length, count);
		const snapshot = await reconnected.call("snapshot", scope);
		assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
		assert.equal(snapshot.messages.filter((message) => message.role === "assistant").length, 1);
		const resumedFrames: Frame[] = [];
		const resumed = await reconnected.observe(scope, (frame) => {
			resumedFrames.push(frame);
		});
		await until(async () => (resumedFrames.length ? true : undefined));
		assert.deepEqual(resumedFrames[0]?.snapshot, snapshot);
		await resumed.dispose();
	} finally {
		await server.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"real PI SQLite in Node child: SIGKILL/restart keeps completed receipt and resumes pending input once",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-ipc-runtime-"));
		let connection = await childClient(directory);
		try {
			const identity = await connection.client.call("handshake", {});
			const scope = await setup(connection.client);
			assert.deepEqual(await connection.client.call("listWorkspaces", {}), {
				items: [{ workspaceId: "work", name: "Test" }],
				nextCursor: null,
			});
			assert.equal(
				(await connection.client.call("listConversations", { workspaceId: "work" })).items[0]?.conversationId,
				scope.conversationId,
			);
			const frames: Frame[] = [];
			const watcher = await connection.client.observe(scope, (frame) => {
				frames.push(frame);
			});
			const input = { ...scope, requestId: "ipc_completed", text: "Complete before process death" };
			const receipt = await connection.client.call("submit", input);
			await until(async () => (frames.some((frame) => frame.snapshot.partial.length > 0) ? true : undefined));
			const final = await completed(connection.client, input.requestId);
			await watcher.dispose();
			await kill(connection.child);
			connection.client.close();
			connection = await childClient(directory, true);
			assert.deepEqual(await connection.client.call("handshake", {}), identity);
			assert.equal(
				(await connection.client.call("listConversations", { workspaceId: "work" })).items[0]?.conversationId,
				scope.conversationId,
			);
			await connection.client.call("openWorkspace", { workspaceId: "work" });
			assert.deepEqual(
				await connection.client.call("getReceipt", { workspaceId: "work", requestId: input.requestId }),
				final,
			);
			assert.equal((await connection.client.call("submit", input)).receiptId, receipt.receiptId);
			assert.equal(
				(await connection.client.call("snapshot", scope)).messages.filter((message) => message.role === "user")
					.length,
				1,
			);
			const pendingInput = { ...scope, requestId: "ipc_interrupted", text: "Resume after process death" };
			const pendingFrames: Frame[] = [];
			await connection.client.observe(scope, (frame) => {
				pendingFrames.push(frame);
			});
			const pendingReceipt = await connection.client.call("submit", pendingInput);
			const dispatched = await until(async () => {
				const receipt = await connection.client.call("getReceipt", {
					workspaceId: scope.workspaceId,
					requestId: pendingInput.requestId,
				});
				return receipt?.submissionId ? receipt : undefined;
			});
			assert.equal(dispatched?.receiptId, pendingReceipt.receiptId);
			assert.equal(dispatched?.state, "dispatched");
			assert.equal(dispatched?.execution, "placed");
			assert.ok(dispatched?.submissionId);
			const partial = await until(
				async () => pendingFrames.find((frame) => frame.snapshot.partial.length > 0)?.snapshot.partial,
			);
			// A delivered frame can be stale by the time the parent runs. The dedicated provider cannot
			// finish, and a separate read-only connection proves this submission's partial is on disk.
			const storage = await openNodeSqliteStorageReadOnly(join(directory, scope.workspaceId, "workspace.sqlite"));
			try {
				const submissionId = Number(dispatched.submissionId) as SubmissionId;
				const submission = await storage.submission(submissionId, BACKGROUND_CONTEXT);
				assert.equal(submission?.status, "placed");
				assert.ok(submission);
				const committed = await until(async () => {
					const record = await storage.findDocument(
						{
							kind: LiveDoc.definition.kind,
							scope: { kind: "conversation", conversationId: submission.conversationId },
						},
						"current",
						BACKGROUND_CONTEXT,
					);
					if (!record) return undefined;
					const document = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
					const live = document?.value as LiveState | undefined;
					return live?.generation?.message ? live : undefined;
				});
				assert.ok(committed.run?.inputs.includes(submissionId));
				const text = committed.generation?.message?.content
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join("");
				assert.equal(text, partial);
			} finally {
				await storage.close(BACKGROUND_CONTEXT);
			}
			await kill(connection.child);
			connection.client.close();
			connection = await childClient(directory);
			assert.deepEqual(await connection.client.call("handshake", {}), identity);
			assert.equal(
				(await connection.client.call("listConversations", { workspaceId: "work" })).items[0]?.conversationId,
				scope.conversationId,
			);
			await connection.client.call("openWorkspace", { workspaceId: "work" });
			const resumed = await completed(connection.client, pendingInput.requestId);
			assert.equal(resumed.receiptId, pendingReceipt.receiptId);
			assert.equal(resumed.submissionId, dispatched.submissionId);
			assert.equal(resumed.requestId, pendingInput.requestId);
			assert.match(resumed.answer ?? "", /deterministic test answer/);
			const after = await connection.client.call("snapshot", scope);
			// PI retains a committed partial as an aborted entry before resuming the same submission.
			// Assert the whole sequence so a duplicate completed answer cannot hide among fragments.
			assert.deepEqual(
				after.messages.map(({ role, interrupted }) => ({ role, interrupted })),
				[
					{ role: "user", interrupted: undefined },
					{ role: "assistant", interrupted: undefined },
					{ role: "user", interrupted: undefined },
					{ role: "assistant", interrupted: true },
					{ role: "assistant", interrupted: undefined },
				],
			);
			assert.equal(new Set(after.messages.map((message) => message.id)).size, after.messages.length);
			assert.equal(after.messages[0]?.text, input.text);
			assert.equal(after.messages[1]?.text, final.answer);
			assert.equal(after.messages[2]?.text, pendingInput.text);
			const interrupted = after.messages[3]?.text;
			assert.ok(interrupted?.startsWith(partial));
			assert.ok(resumed.answer?.startsWith(interrupted));
			assert.equal(after.messages[4]?.text, resumed.answer);
			const page = await connection.client.call("getHistory", scope);
			assert.deepEqual(page.messages, after.messages);
			assert.equal(page.nextCursor, null);
			const answerMessage = after.messages[4];
			assert.ok(answerMessage);
			const chunk = await connection.client.call("getMessageText", {
				...scope,
				messageId: answerMessage.id,
				offset: 0,
			});
			assert.equal(chunk.text, resumed.answer);
			assert.equal(chunk.textLength, resumed.answerLength);
			assert.equal(chunk.nextOffset, null);
			const retried = await connection.client.call("submit", pendingInput);
			assert.equal(retried.receiptId, pendingReceipt.receiptId);
			assert.equal(retried.submissionId, dispatched.submissionId);
			assert.deepEqual(await connection.client.call("snapshot", scope), after);
		} finally {
			connection.client.close();
			await kill(connection.child);
			await rm(directory, { recursive: true, force: true });
		}
	},
);
