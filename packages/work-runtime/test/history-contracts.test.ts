import assert from "node:assert/strict";
import test from "node:test";
import {
	fitsPayloadBudget,
	jsonBytes,
	LIMITS,
	PROTOCOL_VERSION,
	parseFrame,
	parseRequest,
	parseResult,
} from "../src/contracts.ts";

const scope = { workspaceId: "work", conversationId: "conversation" };
const message = { id: "1_0", role: "assistant", text: "hello", textLength: 5, truncated: false };
const snapshot = {
	...scope,
	messages: [message],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: false,
	historyCursor: null,
};
const receipt = {
	...scope,
	requestId: "request",
	receiptId: "receipt",
	state: "dispatched",
	execution: "done",
	answer: "hello",
	answerLength: 5,
	answerTruncated: false,
	answerEntryId: "1",
};

test("optional presentation identities are bounded, assistant-only, unique, and not command authority", () => {
	const first = "1de12561-9171-4806-923d-bd965b721a3b";
	const second = "10230315-a871-4a08-b7e2-f658a9e8a073";
	const identified = { ...snapshot, messages: [{ ...message, streamId: first }], partialId: second };
	assert.deepEqual(parseResult("snapshot", identified), identified);
	assert.deepEqual(
		parseFrame({ kind: "snapshot", epoch: "epoch", version: 1, snapshot: identified }).snapshot,
		identified,
	);
	assert.deepEqual(
		parseResult("getHistory", {
			...scope,
			messages: identified.messages,
			nextCursor: null,
		}).messages,
		identified.messages,
	);
	for (const identity of ["", "arbitrary-public-id", `${first}x`, first.toUpperCase(), null, 42]) {
		assert.throws(() => parseResult("snapshot", { ...snapshot, partialId: identity }), { code: "INVALID_REQUEST" });
		assert.throws(
			() =>
				parseResult("getHistory", {
					...scope,
					messages: [{ ...message, streamId: identity }],
					nextCursor: null,
				}),
			{ code: "INVALID_REQUEST" },
		);
	}
	for (const messages of [
		[{ ...message, role: "user", streamId: first }],
		[
			{ ...message, streamId: first },
			{ ...message, id: "2_0", streamId: first },
		],
	])
		assert.throws(() => parseResult("snapshot", { ...snapshot, messages }), { code: "INVALID_REQUEST" });
	assert.throws(() => parseResult("snapshot", { ...identified, partialId: first }), { code: "INVALID_REQUEST" });
	for (const params of [
		{ ...scope, requestId: "request", text: "hello", streamId: first },
		{ ...scope, requestId: "request", text: "hello", partialId: first },
	])
		assert.throws(() => parseRequest({ version: PROTOCOL_VERSION, method: "submit", params }), {
			code: "INVALID_REQUEST",
		});
	// Legacy history and cold snapshots without optional presentation metadata remain valid.
	assert.deepEqual(parseResult("snapshot", snapshot), snapshot);
});

test("history protocol rejects missing, contradictory and oversized preview metadata", () => {
	assert.deepEqual(parseResult("snapshot", snapshot), snapshot);
	for (const patch of [
		{ textLength: undefined },
		{ truncated: undefined },
		{ textLength: 4 },
		{ textLength: 6 },
		{ truncated: true },
		{ textLength: -1 },
		{ textLength: 1.5 },
		{ text: "x".repeat(LIMITS.messagePreview + 1), textLength: LIMITS.messagePreview + 1 },
		{ unknown: true },
	]) {
		assert.throws(() => parseResult("snapshot", { ...snapshot, messages: [{ ...message, ...patch }] }), {
			code: "INVALID_REQUEST",
		});
	}
	for (const patch of [
		{ partialLength: undefined },
		{ partialTruncated: undefined },
		{ partialLength: 1 },
		{ historyCursor: undefined },
		{ partial: "x".repeat(LIMITS.partialPreview + 1), partialLength: LIMITS.partialPreview + 1 },
		{ messages: Array.from({ length: LIMITS.historyMessages + 1 }, () => message) },
	]) {
		assert.throws(() => parseResult("snapshot", { ...snapshot, ...patch }), { code: "INVALID_REQUEST" });
	}
	const empty = { ...scope, messages: [], nextCursor: "opaque-continuation" };
	assert.deepEqual(parseResult("getHistory", empty), empty);
	assert.throws(() => parseResult("getHistory", { ...empty, nextCursor: "x".repeat(LIMITS.cursor + 1) }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("getHistory", { ...empty, unexpected: true }), { code: "INVALID_REQUEST" });
});

test("receipt answer and failure previews require consistent complete metadata", () => {
	assert.deepEqual(parseResult("getReceipt", receipt), receipt);
	for (const key of ["answer", "answerLength", "answerTruncated", "answerEntryId"]) {
		assert.throws(() => parseResult("getReceipt", { ...receipt, [key]: undefined }), { code: "INVALID_REQUEST" });
	}
	for (const patch of [
		{ answerLength: 6 },
		{ answerTruncated: true },
		{ answerEntryId: "1_0" },
		{ answer: "x".repeat(LIMITS.messagePreview + 1), answerLength: LIMITS.messagePreview + 1 },
	]) {
		assert.throws(() => parseResult("getReceipt", { ...receipt, ...patch }), { code: "INVALID_REQUEST" });
	}
	const reason = {
		...scope,
		requestId: "request",
		receiptId: "receipt",
		state: "dispatched",
		execution: "unanswered",
		reason: "x".repeat(LIMITS.messagePreview),
		reasonLength: 1000000,
		reasonTruncated: true,
	};
	assert.deepEqual(parseResult("getReceipt", reason), reason);
	for (const patch of [
		{ reasonLength: undefined },
		{ reasonTruncated: undefined },
		{ reasonTruncated: false },
		{ reason: "x".repeat(LIMITS.messagePreview + 1) },
	]) {
		assert.throws(() => parseResult("getReceipt", { ...reason, ...patch }), { code: "INVALID_REQUEST" });
	}
});

test("chunk validation rejects nonadvancing, inconsistent and out-of-range positions", () => {
	const chunk = { ...scope, messageId: "1_0", text: "😀", offset: 0, nextOffset: 2, textLength: 3 };
	assert.deepEqual(parseResult("getMessageText", chunk), chunk);
	for (const patch of [
		{ nextOffset: 0 },
		{ nextOffset: 1 },
		{ nextOffset: null },
		{ text: "" },
		{ offset: -1 },
		{ offset: 0.5 },
		{ textLength: 1 },
		{ nextOffset: 2, textLength: 2 },
		{ text: "x".repeat(LIMITS.textChunk + 1), nextOffset: LIMITS.textChunk + 1, textLength: LIMITS.textChunk + 2 },
		{ unexpected: true },
	]) {
		assert.throws(() => parseResult("getMessageText", { ...chunk, ...patch }), { code: "INVALID_REQUEST" });
	}
	const end = { ...chunk, text: "", offset: 3, nextOffset: null };
	assert.deepEqual(parseResult("getMessageText", end), end);
	for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(
			() =>
				parseRequest({
					version: PROTOCOL_VERSION,
					method: "getMessageText",
					params: { ...scope, messageId: "1_0", offset },
				}),
			{ code: "INVALID_REQUEST" },
		);
	}
	for (const params of [
		{ ...scope, cursor: "" },
		{ ...scope, cursor: "x".repeat(LIMITS.cursor + 1) },
		{ ...scope, limit: 100000 },
	]) {
		assert.throws(() => parseRequest({ version: PROTOCOL_VERSION, method: "getHistory", params }), {
			code: "INVALID_REQUEST",
		});
	}
});

test("UTF-8 byte accounting includes JSON escapes and envelope headroom", () => {
	const value = { text: '中文😀"\\\n\u0000' };
	assert.equal(jsonBytes(value), Buffer.byteLength(JSON.stringify(value)));
	const maximum = LIMITS.frameBytes - LIMITS.envelopeBytes;
	assert.equal(fitsPayloadBudget("a".repeat(maximum - 2)), true);
	assert.equal(fitsPayloadBudget("a".repeat(maximum - 1)), false);
	const huge = { ...snapshot, partial: "\u0000".repeat(200000), partialLength: 200000 };
	assert.ok(JSON.stringify(huge).length > LIMITS.frameBytes);
	assert.throws(() => parseFrame({ kind: "snapshot", epoch: "epoch", version: 1, snapshot: huge }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("snapshot", huge), { code: "INVALID_REQUEST" });
	const bounded = {
		...snapshot,
		messages: Array.from({ length: LIMITS.historyMessages }, (_, i) => ({
			...message,
			id: `${i}_0`,
			text: "\u0000".repeat(LIMITS.messagePreview),
			textLength: LIMITS.messagePreview,
		})),
		partial: "\u0000".repeat(LIMITS.partialPreview),
		partialLength: LIMITS.partialPreview,
	};
	const frame = { kind: "snapshot", epoch: "epoch", version: 1, snapshot: bounded };
	assert.deepEqual(parseFrame(frame), frame);
	assert.ok(
		Buffer.byteLength(`data: ${JSON.stringify({ id: "x".repeat(128), kind: "frame", frame })}\n\n`) <
			LIMITS.frameBytes,
	);
});
