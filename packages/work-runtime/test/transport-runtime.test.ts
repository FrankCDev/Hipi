import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessageEvent, normalizeContext } from "@earendil-works/pi-ai";
import { LiveDoc, type LiveState, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorageReadOnly } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppClient, Frame, ObservationStatus, Scope } from "../src/contracts.ts";
import { openRuntime } from "../src/node.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";
import { heldAnswer, heldResponse } from "./helpers/held-response.ts";

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
async function childClient(directory: string, mode: "normal" | "hold" | "release" = "normal") {
	const fixture = mode === "normal" ? "./transport-runtime-child.ts" : "./transport-runtime-partial-child.ts";
	const child = fork(new URL(fixture, import.meta.url), [directory, mode], {
		stdio: ["ignore", "ignore", "inherit", "ipc", mode === "release" ? "pipe" : "ignore"],
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
		return {
			child,
			client: createNodeIpcClient(child),
			releasePartial: async () => {
				const control = child.stdio[4];
				assert.ok(mode === "release" && control instanceof Writable);
				await new Promise<void>((resolve, reject) =>
					control.write(Buffer.from([1]), (error) => (error ? reject(error) : resolve())),
				);
			},
		};
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

test("held response has an exact fixed 10s abort bound and settles cleanup once", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let settled = 0;
	const fixture = heldResponse(() => {
		settled++;
	});
	const model = fixture.models.getModel("faux", "faux-1");
	assert.ok(model);
	const provider = fixture.models.getProvider("faux");
	assert.ok(provider);
	const stream = provider.streamSimple(model, normalizeContext({ messages: [] }));
	context.mock.timers.tick(9999);
	assert.equal(settled, 0);
	context.mock.timers.tick(1);
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(settled, 1);
	assert.throws(() => fixture.release(), /No held response/);
	fixture.dispose();
	context.mock.timers.tick(10000);
	assert.equal(settled, 1);
});

test("held response preserves pending text lifecycle and exact released answer", async () => {
	const fixture = heldResponse();
	try {
		const model = fixture.models.getModel("faux", "faux-1");
		const provider = fixture.models.getProvider("faux");
		assert.ok(model && provider);
		const stream = provider.streamSimple(model, normalizeContext({ messages: [] }));
		const iterator = stream[Symbol.asyncIterator]();
		const events: AssistantMessageEvent[] = [];
		for (let index = 0; index < 3; index++) {
			const next = await iterator.next();
			assert.equal(next.done, false);
			events.push(next.value);
		}
		assert.deepEqual(
			events.map((event) => event.type),
			["start", "text_start", "text_delta"],
		);
		fixture.release();
		for await (const event of stream) events.push(event);
		assert.deepEqual(
			events.map((event) => event.type),
			["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
		);
		for (const event of events) if ("partial" in event) assert.equal(event.partial.stopReason, "pending");
		assert.ok(events[0].type === "start" && events[1].type === "text_start");
		assert.deepEqual(events[0].partial.content, []);
		assert.deepEqual(events[1].partial.content, [{ type: "text", text: "" }]);
		assert.equal(
			events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.delta)
				.join(""),
			heldAnswer,
		);
		assert.equal((await stream.result()).stopReason, "stop");
		assert.deepEqual((await stream.result()).content, [{ type: "text", text: heldAnswer }]);
	} finally {
		fixture.dispose();
	}
});

test("held partial fixture releases its control pipe and stream on parent disconnect", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-ipc-held-disconnect-"));
	const connection = await childClient(directory, "release");
	try {
		const scope = await setup(connection.client);
		await connection.client.call("submit", { ...scope, requestId: "held", text: "Hold until disconnect" });
		await until(async () => ((await connection.client.call("snapshot", scope)).partial ? true : undefined));
		connection.client.close();
		const exited = once(connection.child, "exit");
		connection.child.disconnect();
		const [code, signal] = await exited;
		assert.equal(code, 0);
		assert.equal(signal, null);
	} finally {
		connection.client.close();
		await kill(connection.child);
		await rm(directory, { recursive: true, force: true });
	}
});

test("real PI SQLite via HTTP: streamed execution survives cancelWait and reconnect", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-http-runtime-"));
	const fixture = heldResponse();
	const runtime = await openRuntime(directory, {
		models: fixture.models,
		model: { provider: "faux", modelId: "faux-1" },
		resume: true,
	});
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
		assert.equal((await client.call("snapshot", scope)).partial, "Hipi Work ");
		assert.notEqual(
			(await client.call("getReceipt", { workspaceId: "work", requestId: "http_request" }))?.execution,
			"done",
		);
		wait.abort();
		await watcher.dispose();
		const count = frames.length;
		const reconnected = createHttpClient({ ...server, origin });
		fixture.release();
		const final = await completed(reconnected, "http_request");
		assert.equal(final.answer, heldAnswer);
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
		fixture.dispose();
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
		let connection = await childClient(directory, "release");
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
			let observationClosed: Extract<ObservationStatus, { state: "closed" }> | undefined;
			const watcher = await connection.client.observe(
				scope,
				(frame) => {
					frames.push(frame);
				},
				undefined,
				(status) => {
					if (status.state === "closed") observationClosed = status;
				},
			);
			const input = { ...scope, requestId: "ipc_completed", text: "Complete before process death" };
			const receipt = await connection.client.call("submit", input);
			await until(async () => {
				if (observationClosed)
					throw new Error(
						`IPC initial partial observation closed: ${observationClosed.reason} (${observationClosed.code ?? "none"})`,
					);
				return frames.some((frame) => frame.snapshot.partial.length > 0) ? true : undefined;
			});
			// The normal committed snapshot must still contain the held partial before release.
			assert.equal((await connection.client.call("snapshot", scope)).partial, "Hipi Work ");
			assert.notEqual(
				(await connection.client.call("getReceipt", { workspaceId: "work", requestId: input.requestId }))
					?.execution,
				"done",
			);
			await connection.releasePartial();
			const final = await completed(connection.client, input.requestId);
			assert.equal(final.answer, "Hipi Work deterministic test answer. No model API or external tool was called.");
			await watcher.dispose();
			await kill(connection.child);
			connection.client.close();
			connection = await childClient(directory, "hold");
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
