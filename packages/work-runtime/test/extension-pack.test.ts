import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv } from "ajv";
import { executeToolPack, parseToolPack, toolPackToolId } from "../src/extensions/pack.ts";
import { TOOL_PACK_SCHEMA } from "../src/extensions/pack-schema.ts";

const officialBytes = readFileSync(new URL("../../../examples/tool-packs/official-text-cleanup.json", import.meta.url));
const official = parseToolPack(officialBytes);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const base = () => ({
	formatVersion: 1,
	id: "org.example.words",
	version: "1.2.3",
	name: "Words",
	description: "Literal words",
	tools: [
		{
			id: "replace",
			name: "Replace",
			description: "Replace a literal",
			pipeline: [{ op: "literalReplace", search: "猫", replacement: "🐈" }],
		},
	],
});
const validateSchema = new Ajv({ strict: true }).compile(TOOL_PACK_SCHEMA);

test("published JSON schema matches the TypeScript schema", () => {
	assert.deepEqual(
		JSON.parse(
			readFileSync(new URL("../../../examples/tool-packs/tool-pack-v1.schema.json", import.meta.url), "utf8"),
		),
		TOOL_PACK_SCHEMA,
	);
});

test("official example is a real multi-tool declaration and immutable parsed snapshot", () => {
	assert.equal(executeToolPack(official, "clean_lines", "中文 😀  \r\n\r\n中文 😀\r\n末行\t"), "中文 😀\n末行");
	assert.equal(executeToolPack(official, "normalize_separator", "中文，😀，end"), "中文,😀,end");
	assert.equal(toolPackToolId(official, "clean_lines"), `pack_${official.digest.slice(0, 32)}_clean_lines`);
	assert.ok(Object.isFrozen(official.manifest.tools[0].pipeline[0]));
	assert.throws(() => executeToolPack({ ...official }, "clean_lines", "x"), { code: "INVALID_PACK" });
	assert.throws(() => executeToolPack(official, "hipi_read_file", "x"), { code: "UNKNOWN_TOOL" });
});

test("JSON Schema and strict TypeScript parser agree on structural acceptance", () => {
	const samples: unknown[] = [
		{ ...base(), id: "org.example.words\n" },
		{ ...base(), version: "1.2.3\n" },
		{ ...base(), tools: [{ ...base().tools[0], id: "replace\n" }] },
		base(),
		JSON.parse(officialBytes.toString()),
		null,
		[],
		{},
		{ ...base(), formatVersion: 2 },
		{ ...base(), version: "^1.2.3" },
		{ ...base(), version: "01.2.3" },
		{ ...base(), id: "hipi.core" },
		{ ...base(), id: "file:///x" },
		{ ...base(), name: "😀".repeat(80) },
		{ ...base(), name: "😀".repeat(81) },
		{ ...base(), description: "\ud800" },
	];
	for (const key of ["public", "code", "url", "path", "npm", "wasm", "configuration", "__proto__"])
		samples.push(JSON.parse(`{"${key}":"attack",${JSON.stringify(base()).slice(1)}`));
	for (const step of [
		{ op: "eval" },
		{ op: "regex", pattern: ".*" },
		{ op: "literalReplace", search: "", replacement: "x" },
		{ op: "literalReplace", search: "a", replacement: "x", flags: "g" },
		{ op: "trimLineEnds", extra: true },
		{ op: "literalReplace", search: "😀", replacement: "" },
	]) {
		samples.push({ ...base(), tools: [{ ...base().tools[0], pipeline: [step] }] });
	}
	for (const count of [0, 16, 17])
		samples.push({
			...base(),
			tools: [{ ...base().tools[0], pipeline: Array.from({ length: count }, () => ({ op: "normalizeNewlines" })) }],
		});
	for (const sample of samples) {
		const schemaAccepts = validateSchema(sample);
		let parserAccepts = true;
		try {
			parseToolPack(encode(sample));
		} catch {
			parserAccepts = false;
		}
		assert.equal(parserAccepts, schemaAccepts, JSON.stringify(sample));
	}
});

test("canonical version identity is separate from raw-byte SHA-256", () => {
	const bytes = encode(base());
	const parsed = parseToolPack(bytes);
	const spaced = parseToolPack(new TextEncoder().encode(JSON.stringify(base(), null, 2)));
	assert.equal(parsed.canonicalId, "org.example.words@1.2.3");
	assert.equal(parsed.digest, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(spaced.canonicalId, parsed.canonicalId);
	assert.notEqual(spaced.digest, parsed.digest);
	assert.notEqual(toolPackToolId(spaced, "replace"), toolPackToolId(parsed, "replace"));
	assert.match(toolPackToolId(parsed, "replace"), /^[a-zA-Z0-9_-]{1,64}$/);
	bytes.fill(0);
	assert.equal(executeToolPack(parsed, "replace", "猫"), "🐈");
});

test("byte transport rejects malformed UTF-8, BOM, oversized input and duplicate local IDs", () => {
	for (const bytes of [
		Uint8Array.of(0xff),
		Uint8Array.of(0xc0, 0xaf),
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode(base())]),
	])
		assert.throws(() => parseToolPack(bytes), { code: "INVALID_PACK" });
	assert.throws(() => parseToolPack(new Uint8Array(65_537)), { code: "PACK_TOO_LARGE" });
	const padded = Buffer.concat([encode(base()), Buffer.alloc(65_536 - encode(base()).length, 32)]);
	assert.equal(parseToolPack(padded).canonicalId, "org.example.words@1.2.3");
	assert.throws(() => parseToolPack(encode({ ...base(), tools: [base().tools[0], base().tools[0]] })), {
		code: "INVALID_PACK",
	});
});

test("input and intermediate growth budgets use UTF-8 bytes without truncation", () => {
	const pack = parseToolPack(encode(base()));
	assert.equal(executeToolPack(pack, "replace", "😀".repeat(2048)), "😀".repeat(2048));
	for (const input of ["😀".repeat(2049), "a".repeat(8193), "\ud800", { text: "x" }])
		assert.throws(() => executeToolPack(pack, "replace", input), { code: "INVALID_INPUT" });
	const explosive = parseToolPack(
		encode({
			...base(),
			tools: [
				{
					...base().tools[0],
					pipeline: [
						{ op: "literalReplace", search: "a", replacement: "😀".repeat(1024) },
						{ op: "literalReplace", search: "😀", replacement: "" },
					],
				},
			],
		}),
	);
	assert.throws(() => executeToolPack(explosive, "replace", "a".repeat(8192)), { code: "OUTPUT_TOO_LARGE" });
	assert.equal(executeToolPack(explosive, "replace", "aa"), "");
	assert.throws(() => executeToolPack(pack, "replace", "猫".repeat(2730)), { code: "OUTPUT_TOO_LARGE" });
});

test("literal replacement does not execute replacement patterns or recurse", () => {
	const value = base();
	value.tools[0].pipeline[0] = { op: "literalReplace", search: "a", replacement: "$&a" };
	const pack = parseToolPack(encode(value));
	assert.equal(executeToolPack(pack, "replace", "aa"), "$&a$&a");
});

test("cancellation never returns a successful result for a pre-aborted call", () => {
	const controller = new AbortController();
	controller.abort();
	assert.throws(() => executeToolPack(official, "clean_lines", "中文", { signal: controller.signal }), {
		code: "CANCELLED",
	});
	assert.equal(executeToolPack(official, "clean_lines", "中文", { signal: new AbortController().signal }), "中文");
});
