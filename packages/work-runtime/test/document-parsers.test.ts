import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Worker } from "node:worker_threads";
import { crc32, deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { DOCUMENT_LIMITS, DocumentPreviewError, validateDocumentPreview } from "../src/previews/contracts.ts";
import { DocumentParserPool } from "../src/previews/parser-pool.ts";
import { inspectOfficeZip } from "../src/previews/zip-budget.ts";

interface ZipPart {
	name: string;
	text: string;
	compressed?: boolean;
	declaredSize?: number;
	encrypted?: boolean;
}

/** Small deterministic fixture writer, not a production ZIP parser. */
function zip(parts: ZipPart[]): Buffer {
	const entries: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const part of parts) {
		const name = Buffer.from(part.name);
		const data = Buffer.from(part.text);
		const stored = part.compressed ? deflateRawSync(data) : data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(part.encrypted ? 1 : 0, 6);
		local.writeUInt16LE(part.compressed ? 8 : 0, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(part.declaredSize ?? data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(part.encrypted ? 1 : 0, 8);
		central.writeUInt16LE(part.compressed ? 8 : 0, 10);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(stored.length, 20);
		central.writeUInt32LE(part.declaredSize ?? data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		entries.push(local, name, stored);
		directory.push(central, name);
		offset += local.length + name.length + stored.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(parts.length, 8);
	end.writeUInt16LE(parts.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...entries, central, end]);
}

const base: ZipPart[] = [
	{
		name: "[Content_Types].xml",
		text: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	},
	{
		name: "word/document.xml",
		text: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello &lt;script&gt; 中文</w:t></w:r></w:p></w:body></w:document>',
	},
];

function hasCode(code: string) {
	return (error: unknown) => error instanceof DocumentPreviewError && error.code === code && error.message === code;
}

test("DOCX is plain text and CSV preserves strings, quotes, multiline fields and formula-like strings", async () => {
	const pool = new DocumentParserPool();
	try {
		const doc = await pool.parse("docx", zip(base));
		assert.equal(doc.kind, "document");
		if (doc.kind !== "document") return;
		assert.equal(doc.text.trim(), "Hello <script> 中文");
		const csv = await pool.parse("csv", Buffer.from('id,note,formula\n001,"hello\nworld",=1+1'));
		assert.equal(csv.kind, "spreadsheet");
		if (csv.kind !== "spreadsheet") return;
		assert.deepEqual(
			csv.sheets[0].rows[1].map((cell) => cell.value),
			["001", "hello\nworld", "=1+1"],
		);
		assert.ok(csv.sheets[0].rows.every((row) => row.every((cell) => cell.type === "string")));
		assert.equal(pool.status.retainedBytes, 0);
	} finally {
		await pool.close();
	}
});

test("XLSX exposes typed and displayed cached values, never formula/link properties", async () => {
	const book = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		["Name", "Amount", "Enabled"],
		["Ada", 12.5, true],
	]);
	sheet.B2.z = "0.00";
	sheet.B2.f = 'HYPERLINK("https://invalid.example/", 100)';
	sheet.A2.l = { Target: "https://invalid.example/private" };
	XLSX.utils.book_append_sheet(book, sheet, "Data");
	const bytes: Buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: false });
	const pool = new DocumentParserPool();
	try {
		const preview = await pool.parse("xlsx", bytes);
		assert.equal(preview.kind, "spreadsheet");
		if (preview.kind !== "spreadsheet") return;
		assert.deepEqual(preview.sheets[0].rows[1][1], { type: "number", value: 12.5, display: "12.50" });
		assert.equal(preview.sheets[0].rows[1][2].value, true);
		assert.ok(!JSON.stringify(preview).includes("invalid.example"));
	} finally {
		await pool.close();
	}
});

test("ZIP preflight rejects duplicate paths, traversal, encrypted entries, OLE and DTD/entity input", async () => {
	const malicious: ZipPart[][] = [
		[...base, base[1]],
		[...base, { name: "../escape.xml", text: "x" }],
		[...base, { name: "secret.xml", text: "x", encrypted: true }],
		[...base, { name: "word/embeddings/oleObject1.bin", text: "x" }],
		[...base, { name: "evil.xml", text: '<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///secret">]><x>&ex;</x>' }],
		[...base, { name: "evil.xml", text: "\0<\0!\0D\0O\0C\0T\0Y\0P\0E" }],
		[
			...base,
			{ name: "word/custom-part.data", text: '<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///secret">]><x>&ex;</x>' },
		],
		[...base, { name: "word/custom-part.data", text: "<\0!\0D\0O\0C\0T\0Y\0P\0E\0 x>" }],
	];
	for (const parts of malicious)
		await assert.rejects(
			inspectOfficeZip(zip(parts), "docx"),
			(error: unknown) => error instanceof DocumentPreviewError,
		);
});

test("ZIP streams enforce total inflated bytes and entry count independently", async () => {
	const entropy = Buffer.alloc(1024 * 1024);
	let state = 12345;
	for (let index = 0; index < entropy.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		entropy[index] = state & 255;
	}
	const payload = entropy.toString("hex") + "x".repeat(4 * 1024 * 1024);
	const bomb = zip([
		...base,
		...Array.from({ length: 6 }, (_, index) => ({ name: `data${index}.txt`, text: payload, compressed: true })),
	]);
	assert.ok(bomb.byteLength < DOCUMENT_LIMITS.inputBytes);
	await assert.rejects(inspectOfficeZip(bomb, "docx"), hasCode("DOCUMENT_LIMIT"));
	const many = zip([
		...base,
		...Array.from({ length: DOCUMENT_LIMITS.zipEntries }, (_, index) => ({ name: `e${index}.txt`, text: "" })),
	]);
	await assert.rejects(inspectOfficeZip(many, "docx"), hasCode("DOCUMENT_LIMIT"));
});

test("ZIP budgets reject declared bombs and forged decompressed-size metadata", async () => {
	await assert.rejects(
		inspectOfficeZip(zip([...base, { name: "bomb.xml", text: "a".repeat(300_000), compressed: true }]), "docx"),
		hasCode("DOCUMENT_LIMIT"),
	);
	await assert.rejects(
		inspectOfficeZip(
			zip([...base, { name: "bomb.xml", text: "a".repeat(300_000), compressed: true, declaredSize: 1 }]),
			"docx",
		),
		(error: unknown) => error instanceof DocumentPreviewError,
	);
	await assert.rejects(
		inspectOfficeZip(
			zip([
				...base,
				{ name: "large.xml", text: "x", compressed: true, declaredSize: DOCUMENT_LIMITS.zipEntryBytes + 1 },
			]),
			"docx",
		),
		hasCode("DOCUMENT_LIMIT"),
	);
});

test("output and grid limits are enforced and DTO validator rejects extra executable properties", async () => {
	const pool = new DocumentParserPool();
	try {
		const result = await pool.parse(
			"csv",
			Buffer.from(
				Array.from({ length: 250 }, () => Array.from({ length: 60 }, () => "x".repeat(100)).join(",")).join("\n"),
			),
		);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= DOCUMENT_LIMITS.outputBytes);
		assert.throws(() => validateDocumentPreview({ ...result, html: "<script>" }), hasCode("INVALID_DOCUMENT"));
	} finally {
		await pool.close();
	}
});

test("pool snapshots bytes and bounds worker count, queue count and aggregate bytes before copying", async () => {
	const pool = new DocumentParserPool();
	const input = Buffer.from("hello,world");
	const result = pool.parse("csv", input);
	input.fill(0);
	assert.equal((await result).kind, "spreadsheet");
	await pool.close();
	const stalled = new DocumentParserPool({ workerUrl: new URL("./preview-stalled-worker.ts", import.meta.url) });
	const jobs = Array.from({ length: 10 }, () =>
		stalled.parse("csv", Buffer.from("x")).catch((error: unknown) => error),
	);
	assert.deepEqual(stalled.status, { active: 2, queued: 8, retainedBytes: 10, closed: false });
	await assert.rejects(stalled.parse("csv", Buffer.from("x")), hasCode("PARSER_BUSY"));
	await stalled.close();
	assert.ok(
		(await Promise.all(jobs)).every(
			(error) => error instanceof DocumentPreviewError && error.code === "PARSER_CLOSED",
		),
	);
	assert.deepEqual(stalled.status, { active: 0, queued: 0, retainedBytes: 0, closed: true });
	await assert.rejects(stalled.parse("csv", input), hasCode("PARSER_CLOSED"));
});

test("running and queued abort terminate/release resources and timeout kills an uncooperative worker", async () => {
	const pool = new DocumentParserPool({ workerUrl: new URL("./preview-stalled-worker.ts", import.meta.url) });
	const active = new AbortController();
	const queued = new AbortController();
	const one = pool.parse("csv", Buffer.from("x"), active.signal);
	const two = pool.parse("csv", Buffer.from("x"));
	const three = pool.parse("csv", Buffer.from("x"), queued.signal);
	const rejectedOne = assert.rejects(one, hasCode("ABORTED"));
	const rejectedThree = assert.rejects(three, hasCode("ABORTED"));
	const rejectedTwo = assert.rejects(two, hasCode("PARSER_TIMEOUT"));
	active.abort();
	queued.abort();
	await Promise.all([rejectedOne, rejectedThree, rejectedTwo]);
	assert.deepEqual(pool.status, { active: 0, queued: 0, retainedBytes: 0, closed: false });
	await pool.close();
});

test("admission aggregate byte cap and pre-abort reject before taking ownership", async () => {
	const pool = new DocumentParserPool({ workerUrl: new URL("./preview-stalled-worker.ts", import.meta.url) });
	const bytes = new Uint8Array(DOCUMENT_LIMITS.inputBytes);
	const jobs = Array.from({ length: 4 }, () => pool.parse("csv", bytes).catch((error: unknown) => error));
	await assert.rejects(pool.parse("csv", new Uint8Array([1])), hasCode("PARSER_BUSY"));
	await assert.rejects(pool.parse("csv", new Uint8Array(DOCUMENT_LIMITS.inputBytes + 1)), hasCode("DOCUMENT_LIMIT"));
	await assert.rejects(pool.parse("csv", bytes, AbortSignal.abort()), hasCode("ABORTED"));
	assert.equal(pool.status.retainedBytes, 32 * 1024 * 1024);
	await pool.close();
	await Promise.all(jobs);
	assert.equal(pool.status.retainedBytes, 0);
});

test("failed termination fails the pool closed and never reports a successful close", async () => {
	const original = Worker.prototype.terminate;
	const terminated: Promise<number>[] = [];
	const replacement = mock.method(Worker.prototype, "terminate", function (this: Worker): Promise<number> {
		terminated.push(original.call(this));
		return Promise.reject(new Error("injected termination failure"));
	});
	const pool = new DocumentParserPool({ workerUrl: new URL("./preview-stalled-worker.ts", import.meta.url) });
	try {
		const jobs = Array.from({ length: 3 }, () =>
			pool.parse("csv", Buffer.from("x")).catch((error: unknown) => error),
		);
		await assert.rejects(pool.close(), hasCode("INVALID_DOCUMENT"));
		await Promise.all(jobs);
		assert.equal(pool.status.closed, true);
		await assert.rejects(pool.parse("csv", Buffer.from("x")), hasCode("PARSER_CLOSED"));
		await Promise.all(terminated);
		assert.equal(pool.status.active, 0);
	} finally {
		replacement.mock.restore();
	}
});
