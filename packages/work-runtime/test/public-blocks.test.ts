import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { projectPublicBlocks } from "../src/messages/public-block-projection.ts";
import { PUBLIC_BLOCK_LIMITS, parseMessagePublicBlocks, publicBlocksBytes } from "../src/messages/public-blocks.ts";

test("ordered public text and exact tool positions exclude all private payloads", () => {
	const message = fauxAssistantMessage([
		{ type: "thinking", thinking: "PRIVATE_THINKING", thinkingSignature: "PRIVATE_SIGNATURE" },
		{ type: "text", text: "before", textSignature: "PRIVATE_TEXT_SIGNATURE" },
		fauxToolCall("tool", { secret: "PRIVATE_ARGUMENTS" }, { id: "duplicate" }),
		{ type: "text", text: "after" },
		fauxToolCall("tool", {}, { id: "duplicate" }),
	]);
	const toolCalls = { items: [{ contentIndex: 2 }, { contentIndex: 4 }], total: 2 };
	const value = projectPublicBlocks(message, "beforeafter", toolCalls);
	assert.deepEqual(value, {
		items: [
			{ kind: "text", contentIndex: 1, start: 0, end: 6 },
			{ kind: "tool", contentIndex: 2 },
			{ kind: "text", contentIndex: 3, start: 6, end: 11 },
			{ kind: "tool", contentIndex: 4 },
		],
		total: 4,
		omitted: false,
	});
	assert.deepEqual(parseMessagePublicBlocks(value, { text: "beforeafter", textLength: 11, toolCalls }), value);
	assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
	assert.equal(JSON.stringify(value).includes("duplicate"), false);
});

test("adjacent and empty text parts retain exact UTF-16 ranges; string user content is index zero", () => {
	const value = projectPublicBlocks(
		fauxAssistantMessage([
			{ type: "text", text: "" },
			{ type: "text", text: "😀" },
			{ type: "text", text: "last" },
		]),
		"😀last",
	);
	assert.deepEqual(value.items, [
		{ kind: "text", contentIndex: 0, start: 0, end: 0 },
		{ kind: "text", contentIndex: 1, start: 0, end: 2 },
		{ kind: "text", contentIndex: 2, start: 2, end: 6 },
	]);
	assert.deepEqual(parseMessagePublicBlocks(value, { text: "😀last", textLength: 6 }), value);
	assert.deepEqual(projectPublicBlocks({ role: "user", content: "hi", timestamp: 1 }, "hi"), {
		items: [{ kind: "text", contentIndex: 0, start: 0, end: 2 }],
		total: 1,
		omitted: false,
	});
	assert.deepEqual(projectPublicBlocks(fauxAssistantMessage([]), ""), { items: [], total: 0, omitted: false });
});

test("unknown tool summary stops the ordered prefix without losing text or inventing a position", () => {
	const message = fauxAssistantMessage([
		{ type: "text", text: "one" },
		fauxToolCall("tool", {}),
		{ type: "text", text: "two" },
	]);
	const value = projectPublicBlocks(message, "onetwo", { items: [], total: 1 });
	assert.deepEqual(value, {
		items: [{ kind: "text", contentIndex: 0, start: 0, end: 3 }],
		total: 3,
		omitted: true,
	});
	assert.deepEqual(
		parseMessagePublicBlocks(value, { text: "onetwo", textLength: 6, toolCalls: { items: [], total: 1 } }),
		value,
	);
});

test("descriptor count and serialized byte budgets preserve totals with an explicit bounded prefix", () => {
	const many = fauxAssistantMessage(Array.from({ length: 100 }, () => ({ type: "text" as const, text: "" })));
	const value = projectPublicBlocks(many, "");
	assert.equal(value.items.length, 32);
	assert.equal(value.total, 100);
	assert.equal(value.omitted, true);
	assert.ok(publicBlocksBytes(value) <= PUBLIC_BLOCK_LIMITS.bytes);
	assert.deepEqual(parseMessagePublicBlocks(value, { text: "", textLength: 0 }), value);
	const hugeNumbers = {
		items: Array.from({ length: 32 }, (_, contentIndex) => ({
			kind: "text",
			contentIndex,
			start: Number.MAX_SAFE_INTEGER,
			end: Number.MAX_SAFE_INTEGER,
		})),
		total: 33,
		omitted: true,
	};
	assert.ok(Buffer.byteLength(JSON.stringify(hugeNumbers)) > PUBLIC_BLOCK_LIMITS.bytes);
	assert.throws(() => parseMessagePublicBlocks(hugeNumbers, { text: "", textLength: Number.MAX_SAFE_INTEGER }));
});

test("preview cutoff does not alter canonical offsets and full hydration revalidates surrogate boundaries", () => {
	const full = `${"x".repeat(3000)}😀tail`;
	const value = projectPublicBlocks(
		fauxAssistantMessage([
			{ type: "text", text: "x".repeat(3000) },
			{ type: "text", text: "😀tail" },
		]),
		full,
	);
	assert.deepEqual(parseMessagePublicBlocks(value, { text: full.slice(0, 2048), textLength: full.length }), value);
	assert.deepEqual(parseMessagePublicBlocks(value, { text: full, textLength: full.length }), value);
	const invalid = {
		items: [
			{ kind: "text", contentIndex: 0, start: 0, end: 3001 },
			{ kind: "text", contentIndex: 1, start: 3001, end: full.length },
		],
		total: 2,
		omitted: false,
	};
	// Unseen suffix cannot be validated from a preview; the one canonical reader must revalidate on hydration.
	assert.deepEqual(parseMessagePublicBlocks(invalid, { text: full.slice(0, 2048), textLength: full.length }), invalid);
	assert.throws(() => parseMessagePublicBlocks(invalid, { text: full, textLength: full.length }));
});

test("a surrogate pair spanning original text parts is not split or assigned shifted offsets", () => {
	const value = projectPublicBlocks(
		fauxAssistantMessage([
			{ type: "text", text: "\ud83d" },
			{ type: "text", text: "\ude00" },
		]),
		"😀",
	);
	assert.deepEqual(value, { items: [], total: 2, omitted: true });
	assert.deepEqual(parseMessagePublicBlocks(value, { text: "😀", textLength: 2 }), value);
});

test("strict parsing rejects malformed, inconsistent, overlapping and unsupported public facts", () => {
	const context = { text: "ab", textLength: 2 };
	const item = { kind: "text", contentIndex: 0, start: 0, end: 2 };
	const valid = { items: [item], total: 1, omitted: false };
	for (const patch of [
		{ total: -1 },
		{ total: 1.5 },
		{ total: Infinity },
		{ total: 0 },
		{ total: 2 },
		{ omitted: true },
		{ omitted: "false" },
		{ secret: "x" },
		{ items: new Array(1) },
		{ items: null },
		{ items: Array.from({ length: 33 }, () => item), total: 33 },
	])
		assert.throws(() => parseMessagePublicBlocks({ ...valid, ...patch }, context));
	for (const patch of [
		{ contentIndex: -1 },
		{ contentIndex: NaN },
		{ contentIndex: Number.MAX_SAFE_INTEGER + 1 },
		{ kind: "thinking" },
		{ text: "copied" },
		{ start: -1 },
		{ start: 3 },
		{ end: 3 },
		{ start: 1 },
		{ end: 1 },
		{ start: undefined },
	])
		assert.throws(() => parseMessagePublicBlocks({ ...valid, items: [{ ...item, ...patch }] }, context));
	for (const items of [
		[item, item],
		[
			{ ...item, contentIndex: 1 },
			{ ...item, contentIndex: 0 },
		],
		[item, { ...item, contentIndex: 1, start: 1 }],
		[{ kind: "tool", contentIndex: 0 }],
	])
		assert.throws(() => parseMessagePublicBlocks({ items, total: items.length, omitted: false }, context));
	assert.throws(() =>
		parseMessagePublicBlocks(
			{ items: [{ kind: "tool", contentIndex: 0, start: undefined }], total: 1, omitted: false },
			{
				text: "",
				textLength: 0,
				toolCalls: { items: [{ contentIndex: 0 }], total: 1 },
			},
		),
	);
	assert.throws(() =>
		parseMessagePublicBlocks(
			{ items: [], total: 0, omitted: false },
			{
				text: "",
				textLength: 0,
				toolCalls: { items: [], total: 1 },
			},
		),
	);
	assert.throws(() =>
		parseMessagePublicBlocks(
			{ items: [], total: 1, omitted: true },
			{
				text: "",
				textLength: 0,
				toolCalls: { items: [], total: 2 },
			},
		),
	);
});
