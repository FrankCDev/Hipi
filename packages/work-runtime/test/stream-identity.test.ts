import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	ConversationView,
	EntryId,
	EntryRecord,
	LiveState,
	TaskId,
} from "@earendil-works/pi-durable";
import { LIMITS } from "../src/contracts.ts";
import { previewMessage } from "../src/history.ts";
import { StreamIdentity } from "../src/stream-identity.ts";

const conversationId = 2 as ConversationId;
const taskId = 5 as TaskId;
const partial = {
	role: "assistant" as const,
	api: "faux",
	provider: "faux",
	model: "faux-1",
	usage: fauxAssistantMessage("").usage,
	stopReason: "stop" as const,
	timestamp: 0,
	content: [{ type: "text" as const, text: "same text" }],
};
const live: LiveState = { run: { taskId, inputs: [] }, generation: { attempt: 1, message: partial } };
function view(state: LiveState, entries: EntryRecord[] = []): ConversationView {
	return {
		conversation: { id: conversationId },
		entries,
		docs: { "pi.live": state },
	};
}
function entry(id = 10, patch: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: id as EntryId,
		conversationId,
		kind: "pi.assistant",
		byTaskId: taskId,
		model: [partial],
		...patch,
	};
}
function append(entries: EntryRecord[], start = 0): readonly Op[] {
	return [["p", ["entries"], start, 0, entries as unknown as JsonValue[]]];
}
function project(identity: StreamIdentity, next: ConversationView, ops?: readonly Op[]) {
	return identity.project(
		next,
		{
			workspaceId: "work",
			conversationId: "public",
			messages: next.entries
				.flatMap((item) => {
					const result = previewMessage(item, 0);
					return result ? [result] : [];
				})
				.slice(-LIMITS.historyMessages),
			nextCursor: null,
		},
		ops,
	);
}

test("only a unique exact attributed assistant append inherits a partial identity", () => {
	const identity = new StreamIdentity(conversationId);
	const initial = project(identity, view(live));
	assert.ok(initial.partialId);
	const updated = project(identity, view(live), []);
	assert.equal(updated.partialId, initial.partialId);
	const finalEntry = entry();
	const final = project(identity, view({}, [finalEntry]), append([finalEntry]));
	assert.equal(final.messages[0]?.streamId, initial.partialId);
	assert.equal(final.partialId, undefined);
	assert.equal(project(identity, view({}, [finalEntry]), []).messages[0]?.streamId, initial.partialId);
});

for (const [name, entries] of [
	["missing attribution", [entry(10, { byTaskId: undefined })]],
	["foreign task", [entry(10, { byTaskId: 9 as TaskId })]],
	["foreign conversation", [entry(10, { conversationId: 9 as ConversationId })]],
	["same-task foreign kind", [entry(10, { kind: "plugin.assistant" })]],
	["multiple appends", [entry(), entry(11)]],
	["same-task competing foreign assistant", [entry(), entry(11, { kind: "plugin.assistant" })]],
	["multi-model entry", [entry(10, { model: [partial, partial] })]],
] as const) {
	test(`ambiguous transition falls back: ${name}`, () => {
		const identity = new StreamIdentity(conversationId);
		project(identity, view(live));
		const final = project(identity, view({}, [...entries]), append([...entries]));
		assert.ok(final.messages.length);
		assert.ok(final.messages.every((message) => message.streamId === undefined));
	});
}

test("existing equal-text messages cannot acquire the partial identity", () => {
	const identity = new StreamIdentity(conversationId);
	const existing = entry();
	project(identity, view(live, [existing]));
	const final = project(identity, view({}, [existing]), []);
	assert.equal(final.messages[0]?.streamId, undefined);
});

test("retry and same-attempt recovery create separate episodes without using task alone", () => {
	const identity = new StreamIdentity(conversationId);
	const first = project(identity, view(live));
	const interrupted = entry(10, { model: [fauxAssistantMessage("same text", { stopReason: "aborted" })] });
	const recovering = { run: live.run, generation: { attempt: 1 } };
	const converted = project(identity, view(recovering, [interrupted]), append([interrupted]));
	assert.equal(converted.messages[0]?.streamId, first.partialId);
	const recovered = project(identity, view(live, [interrupted]), []);
	assert.ok(recovered.partialId);
	assert.notEqual(recovered.partialId, first.partialId);
	const retry = project(
		identity,
		view({ run: live.run, generation: { attempt: 2, message: partial } }, [interrupted]),
		[],
	);
	assert.ok(retry.partialId);
	assert.notEqual(retry.partialId, recovered.partialId);
	const finalEntry = entry(11);
	const final = project(identity, view({}, [interrupted, finalEntry]), append([finalEntry], 1));
	assert.equal(final.messages[1]?.streamId, retry.partialId);
});

test("compaction splices, queue replacements, and observer recreation discard continuity", () => {
	for (const replacement of ["compaction", "gap"] as const) {
		const identity = new StreamIdentity(conversationId);
		const old = entry();
		const initial = project(identity, view(live, [old]));
		const next = entry(11);
		const finalView = view({}, [next]);
		const ops: readonly Op[] =
			replacement === "gap"
				? [["r", finalView as unknown as JsonValue]]
				: [["p", ["entries"], 0, 1, [next as unknown as JsonValue]]];
		assert.equal(project(identity, finalView, ops).messages[0]?.streamId, undefined);
		const resumed = project(identity, view(live, [next]), []);
		assert.notEqual(resumed.partialId, initial.partialId);
		assert.notEqual(project(new StreamIdentity(conversationId), view(live, [next])).partialId, resumed.partialId);
	}
});

test("missing task attribution, foreign scope, and disposed late callbacks never invent identity", () => {
	const identity = new StreamIdentity(conversationId);
	assert.equal(project(identity, view({ generation: live.generation })).partialId, undefined);
	const active = project(identity, view(live), []);
	assert.ok(active.partialId);
	const foreign = view(live);
	const wrong = { ...foreign, conversation: { ...foreign.conversation, id: 3 as ConversationId } };
	assert.equal(project(identity, wrong, []).partialId, undefined);
	identity.dispose();
	assert.equal(project(identity, view(live), []).partialId, undefined);
	const finalEntry = entry();
	assert.equal(project(identity, view({}, [finalEntry]), append([finalEntry])).messages[0]?.streamId, undefined);
});

test("committed presentation evidence is retained only for the bounded current history page", () => {
	const identity = new StreamIdentity(conversationId);
	const entries: EntryRecord[] = [];
	let firstId: string | undefined;
	for (let index = 0; index <= LIMITS.historyMessages; index++) {
		const active = project(identity, view(live, entries), index ? [] : undefined);
		firstId ??= active.partialId;
		const next = entry(10 + index);
		entries.push(next);
		project(identity, view({}, entries), append([next], entries.length - 1));
	}
	// A historical read without the bounded page is not allowed to resurrect evicted evidence.
	const first = entries[0];
	assert.ok(first);
	const message = previewMessage(first, 0);
	assert.ok(message);
	const result = identity.project(
		view({}, entries),
		{
			workspaceId: "work",
			conversationId: "public",
			messages: [message],
			nextCursor: null,
		},
		[],
	);
	assert.ok(firstId);
	assert.equal(result.messages[0]?.streamId, undefined);
});
