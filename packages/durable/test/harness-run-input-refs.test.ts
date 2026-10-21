import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool, type EntryId, LiveDoc, RunResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { endRun } from "../src/harness/live.ts";
import { addRunInputRef, boundedRunInputRefs, mergeRunInputRefs } from "../src/harness/run-inputs.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

describe("bounded admitted input references", () => {
	it("keeps a bounded ordered prefix and never repairs a legacy gap with later inputs", () => {
		const refs = { entryIds: [] as EntryId[], total: 0, omitted: false };
		for (let id = 1; id <= 40; id++) addRunInputRef(refs, id as EntryId);
		expect(refs).toEqual({ entryIds: Array.from({ length: 32 }, (_, i) => i + 1), total: 40, omitted: true });
		expect(Buffer.byteLength(JSON.stringify(refs))).toBeLessThanOrEqual(1024);
		const added = { entryIds: [50 as EntryId], total: 1, omitted: false };
		expect(mergeRunInputRefs(undefined, 4, added)).toBeUndefined();
		expect(mergeRunInputRefs(refs, 41, added)).toEqual({ ...refs, total: 42 });
		expect(boundedRunInputRefs({ entryIds: [2, 1] as EntryId[], total: 2, omitted: false }, 2)).toBeUndefined();
	});

	it.each(["one", "all"] as const)(
		"attributes %s steering inputs to the existing group without moving follow-ups",
		async (mode) => {
			const setup = chatSetup();
			setup.settings.steeringMode = mode === "one" ? "one-at-a-time" : "all";
			setup.settings.followUpMode = "all";
			const reached = deferred(),
				release = deferred();
			const tool = defineTool({
				name: "hold",
				description: "hold",
				parameters: Type.Object({}),
				execute: async () => {
					reached.resolve();
					await release.promise;
					return { output: [] };
				},
			});
			addTool(setup.registry, tool);
			setup.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("first"),
				fauxAssistantMessage("next"),
			]);
			const { harness, root } = await openChat(new ControlledStorage(), setup);
			try {
				await root.configure({ tools: [tool] }, context);
				harness.resume();
				const first = await root.submit(
					{ type: "input", content: "initial", entry: { kind: "host.input" } },
					context,
				);
				await reached.promise;
				const steers = [
					await root.submit({ type: "input", content: "steer1", whenBusy: "steer" }, context),
					await root.submit({ type: "input", content: "steer2", whenBusy: "steer" }, context),
				];
				const next = await root.submit({ type: "input", content: "next" }, context);
				const initial = (await first.status(context)).entry!;
				expect((await harness.snapshot(LiveDoc, root.id, context))!.run!.group!.inputRefs).toEqual({
					entryIds: [initial],
					total: 1,
					omitted: false,
				});
				release.resolve();
				await first.wait(context);
				await next.wait(context);
				const entries = await allEntries(root),
					terminals = entries.filter(RunResultEntry.is);
				const ids = await Promise.all(steers.map(async (item) => (await item.status(context)).entry!));
				expect(terminals).toHaveLength(2);
				expect(terminals[0]!.data.inputRefs).toEqual({
					entryIds: [initial, ...ids.slice(0, mode === "all" ? 2 : 1)],
					total: mode === "all" ? 3 : 2,
					omitted: false,
				});
				const nextId = (await next.status(context)).entry!;
				expect(nextId).toBeLessThan(terminals[0]!.id);
				expect(terminals[1]!.data.inputRefs).toEqual({
					entryIds: [...(mode === "one" ? ids.slice(1) : []), nextId],
					total: mode === "all" ? 1 : 2,
					omitted: false,
				});
				expect(terminals.every((entry) => entry.model === undefined)).toBe(true);
			} finally {
				release.resolve();
				await harness.close(context);
			}
		},
	);

	it.each(["missing", "mismatch"] as const)("keeps %s legacy input evidence unknown at settlement", async (kind) => {
		const { harness, root } = await openChat(new ControlledStorage(), chatSetup());
		try {
			await root.submit({ type: "input", content: "go" }, context);
			await root.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, root.id);
				if (kind === "missing") delete live.run!.group!.inputRefs;
				else live.run!.group!.inputRefs!.total = 2;
				await tx.appendEntry(root.id, { kind: "host.display" });
				await endRun(
					tx,
					live,
					live.run!.taskId,
					{ status: "unanswered", reason: "faulted" },
					{ conversationId: root.id, settledAt: 100, terminalCause: "unanswered" },
				);
			}, context);
			const entries = await allEntries(root),
				result = entries.find(RunResultEntry.is)!;
			expect(result.data.inputRefs).toEqual(
				kind === "missing" ? undefined : { entryIds: [entries.find(UserEntry.is)!.id], total: 1, omitted: true },
			);
		} finally {
			await harness.close(context);
		}
	});

	it.each([false, true])("bounds forty placements and keeps reset=%s successor inputs separate", async (reset) => {
		const setup = chatSetup();
		setup.settings.steeringMode = "all";
		const reached = deferred(),
			release = deferred();
		const tool = defineTool({
			name: "hold",
			description: "hold",
			parameters: Type.Object({}),
			execute: async () => {
				reached.resolve();
				await release.promise;
				return { output: [] };
			},
		});
		addTool(setup.registry, tool);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		try {
			await root.configure({ tools: [tool] }, context);
			harness.resume();
			const first = await root.submit({ type: "input", content: "initial" }, context);
			await reached.promise;
			if (reset) await root.reset(undefined, context);
			const steers = [];
			for (let index = 0; index < 40; index++)
				steers.push(await root.submit({ type: "input", content: String(index), whenBusy: "steer" }, context));
			release.resolve();
			await first.wait(context);
			await steers.at(-1)!.wait(context);
			const entries = await allEntries(root),
				terminals = entries.filter(RunResultEntry.is);
			const initial = (await first.status(context)).entry!;
			const placed = await Promise.all(steers.map(async (input) => (await input.status(context)).entry!));
			expect(terminals).toHaveLength(reset ? 2 : 1);
			if (reset)
				expect(terminals[0]!.data).toMatchObject({
					settlement: { status: "unanswered", reason: "reset" },
					inputRefs: { entryIds: [initial], total: 1, omitted: false },
				});
			expect(terminals.at(-1)!.data.inputRefs).toEqual({
				entryIds: (reset ? placed : [initial, ...placed]).slice(0, 32),
				total: reset ? 40 : 41,
				omitted: true,
			});
			expect(Buffer.byteLength(JSON.stringify(terminals.at(-1)!.data.inputRefs))).toBeLessThanOrEqual(1024);
		} finally {
			release.resolve();
			await harness.close(context);
		}
	});

	it("preserves admitted inputs on a nonretryable model failure", async () => {
		const setup = chatSetup();
		setup.settings.retry = { enabled: false, maxRetries: 0, baseDelayMs: 1 };
		setup.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "bad response" })]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		try {
			harness.resume();
			const input = await root.submit({ type: "input", content: "go" }, context);
			const settled = await input.wait(context);
			expect(settled.status).toBe("unanswered");
			const result = (await allEntries(root)).find(RunResultEntry.is)!;
			expect(result.data).toMatchObject({
				settlement: { status: "unanswered", reason: "model_error" },
				inputRefs: { entryIds: [settled.entry], total: 1, omitted: false },
			});
		} finally {
			await harness.close(context);
		}
	});
});
