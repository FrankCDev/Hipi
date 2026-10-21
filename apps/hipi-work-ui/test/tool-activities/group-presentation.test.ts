import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "@hipi/work-runtime/contracts";
import { projectToolGroupPresentation } from "../../src/features/tool-activities/group-presentation.ts";

function snapshot(): Snapshot {
	return {
		workspaceId: "w",
		conversationId: "c",
		running: true,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		historyCursor: null,
		messages: [
			{
				id: "2_0",
				role: "assistant",
				text: "",
				textLength: 0,
				truncated: false,
				toolCalls: {
					items: [
						{ callId: "read", name: "hipi_files_read", contentIndex: 1 },
						{ callId: "list", name: "hipi_files_list", contentIndex: 3 },
					],
					total: 2,
				},
				publicBlocks: {
					items: [
						{ kind: "tool", contentIndex: 1 },
						{ kind: "text", contentIndex: 2, start: 0, end: 0 },
						{ kind: "tool", contentIndex: 3 },
					],
					total: 3,
					omitted: false,
				},
			},
		],
		execution: {
			ownerTaskId: "1",
			submissionIds: [],
			submissionCount: 0,
			blockingCompactionCount: 0,
			tools: {
				total: 2,
				active: 2,
				items: [
					{
						taskId: "4",
						callId: "list",
						name: "hipi_files_list",
						status: "pending",
						anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 3 },
					},
					{
						taskId: "3",
						callId: "read",
						name: "hipi_files_read",
						status: "running",
						anchor: { assistantEntryId: "2", modelIndex: 0, contentIndex: 1 },
					},
				],
			},
		},
	};
}
const project = (value: Snapshot, indexes?: number[]) => projectToolGroupPresentation(value, "2_0", indexes, true);
test("latest active item follows public content order, not task arrival or the first tool", () => {
	const current = snapshot();
	const value = project(current, [1, 3]);
	assert.equal(value.kind, "active");
	if (value.kind === "active") {
		assert.equal(value.toolName, "hipi_files_list");
		assert.equal(value.status, "pending");
	}
	const last = current.execution?.tools.items[0];
	assert.ok(last);
	last.status = "done";
	const remaining = project(current, [1, 3]);
	assert.equal(remaining.kind, "active");
	if (remaining.kind === "active") assert.equal(remaining.toolName, "hipi_files_read");
});
test("a pending model slot keeps its summary key when its task is instantiated", () => {
	const value = snapshot();
	const slot = value.execution?.tools.items[0];
	assert.ok(slot);
	slot.taskId = undefined;
	const pending = project(value);
	slot.taskId = "4";
	slot.status = "running";
	const running = project(value);
	assert.equal(pending.kind, "active");
	assert.equal(running.kind, "active");
	assert.equal(pending.key, running.key);
});
test("following nonempty text, another message or streaming text makes the tool group nonlatest", () => {
	const text = snapshot();
	const message = text.messages[0];
	assert.ok(message?.publicBlocks);
	message.text = "Final";
	message.textLength = 5;
	message.publicBlocks.items.push({ kind: "text", contentIndex: 4, start: 0, end: 5 });
	message.publicBlocks.total++;
	assert.equal(project(text).kind, "summary");
	const later = snapshot();
	later.messages.push({ id: "5_0", role: "assistant", text: "Final", textLength: 5, truncated: false });
	assert.equal(project(later).kind, "summary");
	assert.equal(project({ ...snapshot(), partial: "a", partialLength: 1 }).kind, "summary");
});
test("only the last separated tool block can own the active summary", () => {
	const value = snapshot();
	const message = value.messages[0];
	assert.ok(message?.publicBlocks);
	message.text = "Then";
	message.textLength = 4;
	message.publicBlocks.items[1] = { kind: "text", contentIndex: 2, start: 0, end: 4 };
	assert.equal(project(value, [1]).kind, "summary");
	assert.equal(project(value, [3]).kind, "active");
	assert.equal(project(value).kind, "summary");
});
test("unknown canonical, public-block, slot or anchor coverage never fabricates an active header", () => {
	const variants = [snapshot(), snapshot(), snapshot(), snapshot(), snapshot(), snapshot()];
	const [truncated, omitted, missing, slots, anchor, mismatch] = variants;
	assert.ok(
		truncated?.messages[0] &&
			omitted?.messages[0]?.publicBlocks &&
			missing?.messages[0] &&
			slots?.execution &&
			anchor?.execution?.tools.items[0] &&
			mismatch?.execution?.tools.items[0],
	);
	truncated.messages[0].truncated = true;
	omitted.messages[0].publicBlocks.omitted = true;
	missing.messages[0].publicBlocks = undefined;
	slots.execution.tools.total++;
	anchor.execution.tools.items[0].anchor = undefined;
	mismatch.execution.tools.items[0].name = "unrelated";
	for (const value of variants) assert.equal(project(value).kind, "summary");
});
test("settlement, all-done slots and disconnection suppress active decoration without inferring Thinking", () => {
	const value = snapshot();
	assert.ok(value.execution);
	value.execution.tools.items = value.execution.tools.items.map((tool) => ({ ...tool, status: "done" }));
	value.execution.tools.active = 0;
	assert.equal(project(value).kind, "summary");
	assert.equal(project({ ...snapshot(), running: false }).kind, "summary");
	assert.equal(projectToolGroupPresentation(snapshot(), "2_0", [1, 3], false).kind, "summary");
});
