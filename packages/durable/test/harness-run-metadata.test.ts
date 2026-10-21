import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	defineTool,
	GenerationTask,
	LiveDoc,
	RunResultEntry,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, textOf, unanswered } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

describe("durable observational run membership", () => {
	it("retains a fast answer and terminal facts on reopen without changing model context", async () => {
		const setup = chatSetup();
		setup.now = () => 100;
		setup.faux.setResponses([fauxAssistantMessage("answer", { timestamp: 42 })]);
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, setup);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "question" }, context)).wait(context);
		const entries = await allEntries(root);
		const answer = entries.find(AssistantEntry.is)!;
		const terminal = entries.find(RunResultEntry.is)!;
		expect(settled).toMatchObject({ status: "done", answer: answer.id });
		expect(answer.runId).toBe(answer.byTaskId);
		expect(terminal.data).toEqual({
			runId: answer.runId,
			admittedAt: 100,
			settledAt: 100,
			terminalCause: "response",
			settlement: { status: "done", answer: answer.id },
			answerRequestStartedAt: 42,
		});
		expect(terminal.model).toBeUndefined();
		expect((await root.context(context)).messages.map(textOf)).toEqual(["question", "answer"]);
		const batch = storage.commits.find((writes) =>
			writes.some((write) => write.type === "entry" && write.value.kind === "pi.run-result"),
		)!;
		expect(batch.some((write) => write.type === "submission" && write.value.status === "done")).toBe(true);
		await harness.close(context);
		const reopened = await openChat(storage.reopen(), setup);
		expect((await allEntries(reopened.root)).find(RunResultEntry.is)).toEqual(terminal);
		expect((await reopened.harness.snapshot(LiveDoc, reopened.root.id, context))?.run).toBeUndefined();
		await reopened.harness.close(context);
	});

	it("does not cross a fork's answer-entry fence to discover a later terminal marker", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		harness.resume();
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await allEntries(root);
		const answer = entries.find(AssistantEntry.is)!;
		const terminal = entries.find(RunResultEntry.is)!;
		const before = await root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
		const after = await root.fork(terminal.id, { ownership: { kind: "ownerless" } }, context);
		expect((await allEntries(before)).some(RunResultEntry.is)).toBe(false);
		expect((await allEntries(after)).find(RunResultEntry.is)?.id).toBe(terminal.id);
		expect((await harness.snapshot(LiveDoc, before.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});

	it("keeps onYield continuation in one group and emits no premature terminal record", async () => {
		const setup = chatSetup();
		let yielded = false;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => {
				if (yielded) return;
				yielded = true;
				return { continue: "again" };
			},
		});
		setup.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("last")]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await allEntries(root);
		const answers = entries.filter(AssistantEntry.is);
		const terminals = entries.filter(RunResultEntry.is);
		expect(answers).toHaveLength(2);
		expect(answers[0]!.byTaskId).not.toBe(answers[1]!.byTaskId);
		expect(answers[0]!.runId).toBe(answers[1]!.runId);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]!.data.settlement).toEqual({ status: "done", answer: answers[1]!.id });
		expect(settled).toMatchObject({ status: "done", answer: answers[1]!.id });
		expect((await root.context(context)).messages.map(textOf)).toEqual(["go", "first", "again", "last"]);
		await harness.close(context);
	});

	it.each(["response", "tool-terminate", "tool-handoff"] as const)(
		"records exact model tool membership and %s origin",
		async (cause) => {
			const setup = chatSetup();
			const tool = defineTool({
				name: "read",
				description: "read",
				parameters: Type.Object({}),
				execute: async () => ({
					output: [],
					...(cause === "tool-terminate"
						? { control: { terminate: true } }
						: cause === "tool-handoff"
							? { control: { handoff: "moved" } }
							: {}),
				}),
			});
			addTool(setup.registry, tool);
			setup.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", {}, { id: "call" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const { harness, root } = await openChat(new ControlledStorage(), setup);
			await root.configure({ tools: [tool] }, context);
			harness.resume();
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			const entries = await allEntries(root);
			const answers = entries.filter(AssistantEntry.is);
			const result = entries.find(ToolResultEntry.is)!;
			const terminal = entries.find(RunResultEntry.is)!;
			expect(result.runId).toBe(answers[0]!.runId);
			expect(answers.every((entry) => entry.runId === result.runId)).toBe(true);
			expect(terminal.data.terminalCause).toBe(cause);
			expect(terminal.data.settlement).toEqual({ status: "done", answer: answers.at(-1)!.id });
			if (cause !== "response") expect(terminal.data.answerRequestStartedAt).toBeUndefined();
			expect(answers).toHaveLength(cause === "response" ? 2 : 1);
			await harness.close(context);
		},
	);
	it("keeps compaction and reset context boundaries authoritative", async () => {
		const setup = chatSetup();
		setup.settings.compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, backgroundTokens: 0 };
		setup.faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("summary"),
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		harness.resume();
		for (const content of ["one", "two"])
			await (await root.submit({ type: "input", content }, context)).wait(context);
		const before = await allEntries(root);
		const firstRun = before.find(RunResultEntry.is)!.runId;
		const compacted = await harness.waitForTask(await root.compact(undefined, context), context);
		expect(compacted.state.outcome.status).toBe("completed");
		if (compacted.state.outcome.status !== "completed") throw new Error("compaction did not complete");
		const summarySubmission = compacted.state.outcome.result.submissionId;
		if (summarySubmission !== undefined) await (await harness.submission(summarySubmission, context))!.wait(context);
		const view = await root.context(context);
		expect(view.entries.some((entry) => entry.kind === "pi.compaction")).toBe(true);
		expect(view.entries.some((entry) => entry.runId === firstRun)).toBe(false);
		expect(view.messages.some((message) => textOf(message)?.includes("summary"))).toBe(true);
		expect((await allEntries(root)).filter(RunResultEntry.is)).toHaveLength(2);
		await root.reset(undefined, context);
		expect((await root.context(context)).messages).toEqual([]);
		expect((await allEntries(root)).filter(RunResultEntry.is)).toHaveLength(2);
		await harness.close(context);
	});

	it("records cancellation without inventing an answer request boundary", async () => {
		const setup = chatSetup();
		const pending = unanswered();
		setup.faux.setResponses([pending.step]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		harness.resume();
		const input = await root.submit({ type: "input", content: "go" }, context);
		await pending.reached;
		const run = (await harness.snapshot(LiveDoc, root.id, context))!.run!;
		await harness.abortTask(run.taskId, context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const terminal = (await allEntries(root)).find(RunResultEntry.is)!;
		expect(terminal.runId).toBe(run.group!.id);
		expect(terminal.data).toMatchObject({
			terminalCause: "unanswered",
			settlement: { status: "unanswered", reason: "aborted" },
		});
		expect(terminal.data.answerRequestStartedAt).toBeUndefined();
		await harness.close(context);
	});
	it("round-trips optional membership and terminal metadata through SQLite", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-run-metadata-"));
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("stored")]);
		try {
			const first = await openChat(await openNodeSqliteStorage(path), setup);
			first.harness.resume();
			await (await first.root.submit({ type: "input", content: "go" }, context)).wait(context);
			const entries = await allEntries(first.root);
			await first.harness.close(context);
			const second = await openChat(await openNodeSqliteStorage(path), setup);
			try {
				expect(await allEntries(second.root)).toEqual(entries);
				const terminal = entries.find(RunResultEntry.is)!;
				expect(terminal.runId).toBe(entries.find(AssistantEntry.is)!.runId);
			} finally {
				await second.harness.close(context);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("retains the admitted group across close and active request recovery", async () => {
		const setup = chatSetup();
		const pending = unanswered();
		setup.faux.setResponses([pending.step]);
		const storage = new ControlledStorage();
		const first = await openChat(storage, setup);
		first.harness.resume();
		const input = await first.root.submit({ type: "input", content: "go" }, context);
		await pending.reached;
		const group = (await first.harness.snapshot(LiveDoc, first.root.id, context))!.run!.group!;
		await first.harness.close(context);
		setup.faux.setResponses([fauxAssistantMessage("recovered")]);
		const second = await openChat(storage.reopen(), setup);
		expect((await second.harness.snapshot(LiveDoc, second.root.id, context))!.run!.group).toEqual(group);
		second.harness.resume();
		expect(await (await second.harness.submission(input.id, context))!.wait(context)).toMatchObject({
			status: "done",
		});
		const terminal = (await allEntries(second.root)).find(RunResultEntry.is)!;
		expect(terminal.data.runId).toBe(group.id);
		expect(terminal.data.admittedAt).toBe(group.admittedAt);
		await second.harness.close(context);
	});
});
