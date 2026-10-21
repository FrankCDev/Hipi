import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, RunResultEntry, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { convertPartial } from "../src/harness/generation.ts";
import { endRun } from "../src/harness/live.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

describe("run observation transaction boundaries", () => {
	it("rolls back marker, live removal and submission settlement together", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const input = await root.submit({ type: "input", content: "go" }, context);
		const before = (await harness.snapshot(LiveDoc, root.id, context))!;
		const entries = await allEntries(root);
		await expect(
			root.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, root.id);
				await endRun(
					tx,
					live,
					live.run!.taskId,
					{ status: "unanswered", reason: "aborted" },
					{ conversationId: root.id, settledAt: 100, terminalCause: "unanswered" },
				);
				throw new Error("rollback");
			}, context),
		).rejects.toThrow("rollback");
		expect(await allEntries(root)).toEqual(entries);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual(before);
		expect(await input.status(context)).toMatchObject({ status: "placed" });
		await harness.close(context);
	});

	it("does not record a stale owner or inconsistent terminal cause", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const input = await root.submit({ type: "input", content: "go" }, context);
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			await endRun(
				tx,
				live,
				(Number(live.run!.taskId) + 1000) as TaskId,
				{ status: "unanswered", reason: "aborted" },
				{ conversationId: root.id, settledAt: 100, terminalCause: "unanswered" },
			);
		}, context);
		expect((await allEntries(root)).some(RunResultEntry.is)).toBe(false);
		expect(await input.status(context)).toMatchObject({ status: "placed" });
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			await endRun(
				tx,
				live,
				live.run!.taskId,
				{ status: "unanswered", reason: "aborted" },
				{ conversationId: root.id, settledAt: 100, terminalCause: "response" },
			);
		}, context);
		expect((await allEntries(root)).some(RunResultEntry.is)).toBe(false);
		expect(await input.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		await harness.close(context);
	});

	it("omits arbitrary short host reasons and detail only from observational metadata", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const input = await root.submit({ type: "input", content: "go" }, context);
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			await endRun(
				tx,
				live,
				live.run!.taskId,
				{ status: "unanswered", reason: "private-host-value", detail: { secret: "do-not-copy" } },
				{ conversationId: root.id, settledAt: 100, terminalCause: "unanswered" },
			);
		}, context);
		expect((await allEntries(root)).find(RunResultEntry.is)?.data.settlement).toEqual({ status: "unanswered" });
		expect(await input.status(context)).toMatchObject({
			status: "unanswered",
			reason: "private-host-value",
			detail: { secret: "do-not-copy" },
		});
		await harness.close(context);
	});

	it("preserves unknown legacy midrun and mixed old-writer evidence without version migration", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		const input = await root.submit({ type: "input", content: "go" }, context);
		const group = (await harness.snapshot(LiveDoc, root.id, context))!.run!.group!;
		// An old writer can preserve group while producing an unstamped assistant.
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			live.run!.taskId = live.run!.taskId;
			await tx.appendEntry(AssistantEntry, root.id, { model: [fauxAssistantMessage("old writer")] });
		}, context);
		expect((await harness.snapshot(LiveDoc, root.id, context))!.run!.group).toEqual(group);
		expect((await allEntries(root)).find(AssistantEntry.is)?.runId).toBeUndefined();
		// Existing old settlement logic may drop the run without emitting a marker.
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			for (const id of live.run!.inputs) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
			delete live.run;
		}, context);
		expect(await input.status(context)).toMatchObject({ status: "unanswered" });
		expect((await allEntries(root)).some(RunResultEntry.is)).toBe(false);
		const next = await root.submit({ type: "input", content: "next" }, context);
		const nextGroup = (await harness.snapshot(LiveDoc, root.id, context))!.run!.group!;
		expect(nextGroup.id).not.toBe(group.id);
		// An old midrun has no group. New settlement must not manufacture its admission.
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			delete live.run!.group;
			await endRun(
				tx,
				live,
				live.run!.taskId,
				{ status: "unanswered", reason: "aborted" },
				{ conversationId: root.id, settledAt: 100, terminalCause: "unanswered" },
			);
		}, context);
		expect(await next.status(context)).toMatchObject({ status: "unanswered" });
		expect((await allEntries(root)).some(RunResultEntry.is)).toBe(false);
		expect(LiveDoc.definition.version).toBe(1);
		await harness.close(context);
	});
	it("does not stamp a recovered partial with another owner's group", async () => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		await root.submit({ type: "input", content: "go" }, context);
		await root.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			const message = fauxAssistantMessage("partial");
			live.generation = {
				attempt: 1,
				message: {
					role: "assistant",
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
					timestamp: message.timestamp,
					content: [{ type: "text", text: "partial" }],
				},
			};
			await convertPartial(tx, live, root.id, (Number(live.run!.taskId) + 1000) as TaskId);
		}, context);
		const partial = (await allEntries(root)).find(AssistantEntry.is)!;
		expect(partial.runId).toBeUndefined();
		expect(partial.model?.[0]).toMatchObject({ stopReason: "aborted" });
		await harness.close(context);
	});
});
