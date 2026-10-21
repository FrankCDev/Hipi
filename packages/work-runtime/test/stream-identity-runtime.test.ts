import assert from "node:assert/strict";
import test from "node:test";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { type Frame, parseFrame, type Snapshot } from "../src/contracts.ts";
import { PiWorkspace } from "../src/pi-workspace.ts";
import { deterministicModels } from "../src/testing.ts";

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for real PI watch");
}
async function setup() {
	const requests: { push(text: string): void; finish(message: AssistantMessage): void }[] = [];
	const models = createModels();
	const provider = deterministicModels().getProvider("faux");
	assert.ok(provider);
	models.setProvider({
		...provider,
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			let partial = fauxAssistantMessage("");
			let finished = false;
			const finish = (message: AssistantMessage) => {
				if (finished) return;
				finished = true;
				options?.signal?.removeEventListener("abort", abort);
				if (message.stopReason === "aborted" || message.stopReason === "error")
					stream.push({ type: "error", reason: message.stopReason, error: message });
				else stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			};
			const abort = () => finish({ ...partial, stopReason: "aborted" });
			options?.signal?.addEventListener("abort", abort, { once: true });
			requests.push({
				push(text) {
					partial = {
						...fauxAssistantMessage(text),
						api: model.api,
						provider: model.provider,
						model: model.id,
					};
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
				},
				finish,
			});
			return stream;
		},
	});
	const errors: unknown[] = [];
	const workspace = await PiWorkspace.open(new MemoryStorage(), {
		workspaceId: "work",
		name: "Identity",
		models,
		model: { provider: "faux", modelId: "faux-1" },
		resume: true,
		onError: (error) => errors.push(error),
	});
	const created = await workspace.createConversation({
		workspaceId: "work",
		requestId: "create",
		title: "Identity",
	});
	const scope = { workspaceId: "work", conversationId: created.conversationId };
	return { workspace, scope, requests, errors };
}
function latestPartial(frames: Frame[], text: string): Snapshot | undefined {
	const snapshot = frames.findLast((frame) => frame.snapshot.partial === text)?.snapshot;
	return snapshot?.partialId ? snapshot : undefined;
}

test(
	"real PiWorkspace watch carries canonical final identity, while cold history and reconnect do not invent one",
	{ timeout: 15000 },
	async () => {
		const { workspace, scope, requests, errors } = await setup();
		const frames: Frame[] = [];
		const watcher = await workspace.observe(scope, (frame) => {
			frames.push(parseFrame(frame));
		});
		try {
			await workspace.submit({ ...scope, requestId: "first", text: "Hello" });
			const request = await until(() => requests[0]);
			const beforeText = await until(() => frames.findLast((frame) => frame.snapshot.execution)?.snapshot);
			assert.equal(beforeText.partial, "");
			assert.equal(beforeText.execution?.generation?.attempt, 1);
			const receipt = await workspace.getReceipt("first");
			assert.deepEqual(beforeText.execution?.submissionIds, [receipt?.submissionId]);
			request.push("Streaming prefix");
			const active = await until(() => latestPartial(frames, "Streaming prefix"));
			request.finish(fauxAssistantMessage("Different canonical final"));
			const final = await until(() =>
				frames.findLast((frame) =>
					frame.snapshot.messages.some((message) => message.streamId === active.partialId),
				),
			);
			const committed = final.snapshot.messages.find((message) => message.streamId === active.partialId);
			assert.equal(committed?.text, "Different canonical final");
			assert.ok(committed?.id);
			assert.equal(final.snapshot.partialId, undefined);
			assert.equal(final.snapshot.execution, undefined);
			assert.equal((await workspace.snapshot(scope)).messages.at(-1)?.streamId, undefined);
			assert.equal((await workspace.getHistory(scope)).messages.at(-1)?.streamId, undefined);
			const reopened: Frame[] = [];
			const other = await workspace.observe(scope, (frame) => {
				reopened.push(frame);
			});
			await until(() => reopened[0]);
			assert.ok(
				reopened.every((frame) => frame.snapshot.messages.every((message) => message.streamId === undefined)),
			);
			await other.dispose();
			assert.deepEqual(errors, []);
		} finally {
			await watcher.dispose();
			await workspace.close();
		}
	},
);

for (const mode of ["retry", "tool round"] as const) {
	test(
		`real PiWorkspace ${mode} commits each generation under a separate presentation identity`,
		{ timeout: 15000 },
		async () => {
			const { workspace, scope, requests, errors } = await setup();
			const frames: Frame[] = [];
			const watcher = await workspace.observe(scope, (frame) => {
				frames.push(parseFrame(frame));
			});
			try {
				await workspace.submit({ ...scope, requestId: "first", text: "Hello" });
				const first = await until(() => requests[0]);
				first.push("first prefix");
				const active = await until(() => latestPartial(frames, "first prefix"));
				first.finish(
					mode === "retry"
						? fauxAssistantMessage("retry canonical", { stopReason: "error", errorMessage: "429 rate limit" })
						: fauxAssistantMessage(
								[
									{ type: "text", text: "tool canonical" },
									fauxToolCall("unavailable_fixture_tool", {}, { id: "call" }),
								],
								{ stopReason: "toolUse" },
							),
				);
				await until(() =>
					frames.find((frame) => frame.snapshot.messages.some((message) => message.streamId === active.partialId)),
				);
				const second = await until(() => requests[1]);
				second.push("second prefix");
				const next = await until(() => latestPartial(frames, "second prefix"));
				assert.deepEqual(next.execution?.submissionIds, active.execution?.submissionIds);
				if (mode === "tool round") {
					assert.notEqual(next.execution?.ownerTaskId, active.execution?.ownerTaskId);
					const round = frames.find((frame) =>
						frame.snapshot.execution?.tools.items.some((tool) => tool.callId === "call"),
					)?.snapshot;
					const tool = round?.execution?.tools.items.find((item) => item.callId === "call");
					assert.ok(tool?.anchor);
					assert.equal(tool.taskId, undefined);
					assert.equal(tool.anchor.contentIndex, 1);
					assert.equal(tool.anchor.modelIndex, 0);
					assert.ok(
						round?.messages.some(
							(message) => message.id === `${tool.anchor?.assistantEntryId}_${tool.anchor?.modelIndex}`,
						),
					);
					assert.equal(next.execution?.tools.total, 0);
				} else {
					assert.equal(next.execution?.ownerTaskId, active.execution?.ownerTaskId);
					assert.ok(frames.some((frame) => frame.snapshot.execution?.generation?.retryAt !== undefined));
					assert.equal(next.execution?.generation?.attempt, 2);
				}
				assert.notEqual(next.partialId, active.partialId);
				second.finish(fauxAssistantMessage("final canonical"));
				const final = await until(() =>
					frames.findLast(
						(frame) =>
							!frame.snapshot.running &&
							frame.snapshot.messages.some((message) => message.text === "final canonical"),
					),
				);
				assert.equal(final.snapshot.messages.at(-1)?.streamId, next.partialId);
				assert.equal(final.snapshot.messages.filter((message) => message.streamId === active.partialId).length, 1);
				assert.deepEqual(errors, []);
			} finally {
				await watcher.dispose();
				await workspace.close();
			}
		},
	);
}

test(
	"real abort preserves attributed interrupted output and disposed observers ignore late completions",
	{ timeout: 15000 },
	async () => {
		const { workspace, scope, requests } = await setup();
		const frames: Frame[] = [];
		const watcher = await workspace.observe(scope, (frame) => {
			frames.push(parseFrame(frame));
		});
		try {
			await workspace.submit({ ...scope, requestId: "first", text: "Hello" });
			const request = await until(() => requests[0]);
			request.push("Interrupted prefix");
			const active = await until(() => latestPartial(frames, "Interrupted prefix"));
			await workspace.cancelExecution(scope);
			const final = await until(() =>
				frames.findLast((frame) => frame.snapshot.messages.some((message) => message.interrupted)),
			);
			const interrupted = final.snapshot.messages.find((message) => message.interrupted);
			assert.equal(interrupted?.streamId, active.partialId);
			assert.equal(interrupted?.text, "Interrupted prefix");
			assert.equal(final.snapshot.execution, undefined);
			await watcher.dispose();
			const count = frames.length;
			request.finish(fauxAssistantMessage("late ignored result"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(frames.length, count);
		} finally {
			await watcher.dispose();
			await workspace.close();
		}
	},
);

test("real active reconnect has a fresh observer-local identity", { timeout: 15000 }, async () => {
	const { workspace, scope, requests } = await setup();
	const frames: Frame[] = [];
	const first = await workspace.observe(scope, (frame) => {
		frames.push(parseFrame(frame));
	});
	try {
		await workspace.submit({ ...scope, requestId: "first", text: "Hello" });
		const request = await until(() => requests[0]);
		request.push("same partial");
		const active = await until(() => latestPartial(frames, "same partial"));
		await first.dispose();
		const nextFrames: Frame[] = [];
		const second = await workspace.observe(scope, (frame) => {
			nextFrames.push(parseFrame(frame));
		});
		try {
			const next = await until(() => latestPartial(nextFrames, "same partial"));
			assert.notEqual(next.partialId, active.partialId);
			assert.deepEqual(next.execution, active.execution);
			request.finish(fauxAssistantMessage("same partial"));
			const final = await until(() =>
				nextFrames.findLast((frame) =>
					frame.snapshot.messages.some((message) => message.streamId === next.partialId),
				),
			);
			assert.equal(final.snapshot.messages.at(-1)?.streamId, next.partialId);
		} finally {
			await second.dispose();
		}
	} finally {
		await first.dispose();
		await workspace.close();
	}
});

test(
	"real bounded watch overflow drops stale identity evidence rather than guessing across the gap",
	{ timeout: 30000 },
	async () => {
		const { workspace, scope, requests, errors } = await setup();
		const frames: Frame[] = [];
		const blocked = Promise.withResolvers<void>();
		let held = false;
		const watcher = await workspace.observe(scope, async (frame) => {
			frames.push(parseFrame(frame));
			if (!held && frame.snapshot.partial === "held") {
				held = true;
				await blocked.promise;
			}
		});
		// A second normal observer establishes actual committed progress, not timer guesses.
		const progress: Frame[] = [];
		const healthy = await workspace.observe(scope, (frame) => {
			progress.push(parseFrame(frame));
		});
		try {
			await workspace.submit({ ...scope, requestId: "first", text: "Hello" });
			const request = await until(() => requests[0]);
			request.push("held");
			const old = await until(() => latestPartial(frames, "held"));
			for (let index = 0; index < 105; index++) {
				const text = `overflow ${index}`;
				request.push(text);
				await until(() => latestPartial(progress, text));
			}
			request.finish(fauxAssistantMessage("overflow canonical"));
			await until(() =>
				progress.findLast((frame) =>
					frame.snapshot.messages.some((message) => message.text === "overflow canonical"),
				),
			);
			blocked.resolve();
			const final = await until(() =>
				frames.findLast((frame) =>
					frame.snapshot.messages.some((message) => message.text === "overflow canonical"),
				),
			);
			assert.notEqual(final.snapshot.messages.at(-1)?.streamId, old.partialId);
			assert.ok(frames.some((frame) => frame.snapshot.partialId && frame.snapshot.partialId !== old.partialId));
			assert.deepEqual(errors, []);
		} finally {
			blocked.resolve();
			await watcher.dispose();
			await healthy.dispose();
			await workspace.close();
		}
	},
);
