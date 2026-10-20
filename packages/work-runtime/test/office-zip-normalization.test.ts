import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { fromBufferPromise } from "yauzl";
import { DOCUMENT_LIMITS, DocumentPreviewError } from "../src/previews/contracts.ts";
import { DocumentParserPool } from "../src/previews/parser-pool.ts";
import { parseDocumentBytes } from "../src/previews/parsers.ts";
import { inspectOfficeZip } from "../src/previews/zip-budget.ts";

const documentParts: ReadonlyArray<readonly [string | Buffer, string]> = [
	[
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	],
	[
		"word/document.xml",
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Compatibility 中文</w:t></w:r></w:p></w:body></w:document>',
	],
	["word/中文.xml", "<x>UTF-8 path</x>"],
];

/** Synthetic ZIP writer. Buffer names use CP437; string names use UTF-8. */
function documentZip(mode: "descriptor" | "descriptor-no-signature" | "zip64", parts = documentParts): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [path, text] of parts) {
		const name = typeof path === "string" ? Buffer.from(path) : path;
		const data = Buffer.from(text);
		const compressed = deflateRawSync(data);
		const flags = (typeof path === "string" ? 0x800 : 0) | (mode === "zip64" ? 0 : 8);
		const extra = mode === "zip64" ? Buffer.alloc(20) : Buffer.alloc(0);
		if (extra.length) {
			extra.writeUInt16LE(1);
			extra.writeUInt16LE(16, 2);
			extra.writeBigUInt64LE(BigInt(data.length), 4);
			extra.writeBigUInt64LE(BigInt(compressed.length), 12);
		}
		const local = Buffer.alloc(30);
		const central = Buffer.alloc(46);
		const descriptor = Buffer.alloc(mode === "descriptor" ? 16 : mode === "descriptor-no-signature" ? 12 : 0);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(mode === "zip64" ? 45 : 20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(mode === "zip64" ? crc32(data) : 0, 14);
		local.writeUInt32LE(mode === "zip64" ? 0xffffffff : 0, 18);
		local.writeUInt32LE(mode === "zip64" ? 0xffffffff : 0, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(extra.length, 28);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(45, 4);
		central.writeUInt16LE(mode === "zip64" ? 45 : 20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(mode === "zip64" ? 0xffffffff : compressed.length, 20);
		central.writeUInt32LE(mode === "zip64" ? 0xffffffff : data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(extra.length, 30);
		central.writeUInt32LE(offset, 42);
		if (descriptor.length) {
			const start = mode === "descriptor" ? 4 : 0;
			if (start) descriptor.writeUInt32LE(0x08074b50);
			descriptor.writeUInt32LE(crc32(data), start);
			descriptor.writeUInt32LE(compressed.length, start + 4);
			descriptor.writeUInt32LE(data.length, start + 8);
		}
		locals.push(local, name, extra, compressed, descriptor);
		centrals.push(central, name, extra);
		offset += local.length + name.length + extra.length + compressed.length + descriptor.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(parts.length, 8);
	end.writeUInt16LE(parts.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	if (mode === "zip64") {
		const record = Buffer.alloc(56);
		const locator = Buffer.alloc(20);
		record.writeUInt32LE(0x06064b50);
		record.writeBigUInt64LE(44n, 4);
		record.writeUInt16LE(45, 12);
		record.writeUInt16LE(45, 14);
		record.writeBigUInt64LE(BigInt(parts.length), 24);
		record.writeBigUInt64LE(BigInt(parts.length), 32);
		record.writeBigUInt64LE(BigInt(directory.length), 40);
		record.writeBigUInt64LE(BigInt(offset), 48);
		locator.writeUInt32LE(0x07064b50);
		locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
		locator.writeUInt32LE(1, 16);
		end.writeUInt16LE(0xffff, 8);
		end.writeUInt16LE(0xffff, 10);
		end.writeUInt32LE(0xffffffff, 12);
		end.writeUInt32LE(0xffffffff, 16);
		return Buffer.concat([...locals, directory, record, locator, end]);
	}
	return Buffer.concat([...locals, directory, end]);
}

for (const mode of ["descriptor", "descriptor-no-signature", "zip64"] as const) {
	test(`Office normalization preserves ${mode} DOCX and UTF-8 names without changing input`, async () => {
		const input = documentZip(mode);
		const snapshot = Buffer.from(input);
		const output = await inspectOfficeZip(input, "docx");
		assert.deepEqual(input, snapshot);
		assert.notEqual(output, input);
		assert.ok(
			output.length <=
				DOCUMENT_LIMITS.zipBytes + 2 * DOCUMENT_LIMITS.inputBytes + 76 * DOCUMENT_LIMITS.zipEntries + 22,
		);
		const archive = await fromBufferPromise(output, { validateEntrySizes: true, strictFileNames: true });
		const names: string[] = [];
		let payload = 0;
		let metadata = 22;
		try {
			for await (const entry of archive.eachEntry()) {
				names.push(entry.fileName);
				assert.equal(entry.compressionMethod, 0);
				assert.equal(entry.generalPurposeBitFlag, 0x800);
				assert.equal(entry.compressedSize, entry.uncompressedSize);
				assert.equal(entry.extraFieldLength, 0);
				assert.equal(entry.fileCommentLength, 0);
				assert.equal(entry.lastModFileDate, 33);
				const local = await archive.readLocalFileHeaderPromise(entry);
				assert.equal(local.uncompressedSize, entry.uncompressedSize);
				assert.equal(local.compressedSize, entry.compressedSize);
				assert.equal(local.crc32, entry.crc32);
				assert.equal(local.fileName.toString("utf8"), entry.fileName);
				assert.equal(local.extraFieldLength, 0);
				assert.equal(local.lastModFileDate, 33);
				payload += entry.uncompressedSize;
				metadata += 76 + 2 * Buffer.byteLength(entry.fileName);
			}
		} finally {
			archive.close();
		}
		assert.equal(output.length, payload + metadata);
		assert.equal(output.readUInt16LE(output.length - 14), names.length);
		assert.equal(output.readUInt16LE(output.length - 12), names.length);
		assert.ok(names.includes("word/中文.xml"));
		assert.deepEqual(await inspectOfficeZip(output, "docx"), output);
		const outputSnapshot = Buffer.from(output);
		input.fill(0);
		assert.deepEqual(output, outputSnapshot);
		const pool = new DocumentParserPool();
		try {
			const preview = await pool.parse("docx", snapshot);
			assert.equal(preview.kind, "document");
			if (preview.kind === "document") assert.equal(preview.text.trim(), "Compatibility 中文");
		} finally {
			await pool.close();
		}
	});
}

test("Office normalization preserves ordinary compressed XLSX typed values and Unicode sheet names", async () => {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["中文", 42, true]]), "示例");
	const input: Buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true });
	const pool = new DocumentParserPool();
	try {
		const preview = await pool.parse("xlsx", input);
		assert.equal(preview.kind, "spreadsheet");
		if (preview.kind !== "spreadsheet") return;
		assert.equal(preview.sheets[0].name, "示例");
		assert.deepEqual(
			preview.sheets[0].rows[0].map((cell) => cell.value),
			["中文", 42, true],
		);
	} finally {
		await pool.close();
	}
});

for (const mode of ["forged-local-size", "hidden-entry-count"] as const) {
	test(`Office normalization prevents downstream allocation from ${mode}`, async () => {
		const hiddenName = "uninspected.data";
		const parts: ReadonlyArray<readonly [string, string]> = [
			[
				"[Content_Types].xml",
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
			],
			[
				"xl/workbook.xml",
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
			],
			[
				"xl/_rels/workbook.xml.rels",
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
			],
			[
				"xl/worksheets/sheet1.xml",
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
			],
			[hiddenName, mode === "hidden-entry-count" ? "<!DOCTYPE must-not-reach-parser>" : "small safe payload"],
		];
		const input = documentZip("descriptor", parts);
		assert.ok(input.length < 4096);
		const localOffset = input.indexOf(Buffer.from(hiddenName)) - 30;
		assert.equal(input.readUInt32LE(localOffset), 0x04034b50);
		const forgedSize = DOCUMENT_LIMITS.zipEntryBytes + 1;
		input.writeUInt32LE(forgedSize, localOffset + 22);
		if (mode === "hidden-entry-count") {
			// yauzl reads total entries (+10); SheetJS reads entries on this disk (+8).
			// The hidden entry contains a declaration rejected when it is inspected.
			await assert.rejects(inspectOfficeZip(input, "xlsx"), { code: "UNSAFE_DOCUMENT" });
			input.writeUInt16LE(parts.length - 1, input.length - 12);
		}
		const normalized = await inspectOfficeZip(input, "xlsx");
		assert.ok(normalized.length < 4096);
		assert.equal(normalized.includes(Buffer.from("<!DOCTYPE")), false);
		assert.equal(normalized.includes(Buffer.from(hiddenName)), mode === "forged-local-size");

		// Prove the original header differential without ever allocating the forged
		// size. The same guard protects the production-path regression if it breaks.
		const original = Buffer.allocUnsafe;
		const blocked: number[] = [];
		const sentinel = new Error("FORGED_ALLOCATION_BLOCKED");
		const allocation = mock.method(Buffer, "allocUnsafe", (size: number) => {
			if (size > DOCUMENT_LIMITS.zipEntryBytes) {
				blocked.push(size);
				throw sentinel;
			}
			return original(size);
		});
		try {
			assert.throws(
				() => XLSX.read(input, { type: "buffer" }),
				(error: unknown) => error === sentinel,
			);
			assert.deepEqual(blocked, [forgedSize]);
			const preview = await parseDocumentBytes("xlsx", input);
			assert.equal(preview.kind, "spreadsheet");
			if (preview.kind === "spreadsheet") assert.equal(preview.sheets[0].rows[0][0].value, 42);
			assert.deepEqual(blocked, [forgedSize]);
		} finally {
			allocation.mock.restore();
		}
		const pool = new DocumentParserPool();
		try {
			const preview = await pool.parse("xlsx", input);
			assert.equal(preview.kind, "spreadsheet");
			if (preview.kind === "spreadsheet") assert.equal(preview.sheets[0].rows[0][0].value, 42);
			assert.equal(pool.status.retainedBytes, 0);
		} finally {
			await pool.close();
		}
	});
}

test("Office normalization rejects corrupt CRC and symlink metadata before generating a new archive", async () => {
	for (const kind of ["crc", "symlink"] as const) {
		const input = documentZip("descriptor");
		const directory = input.readUInt32LE(input.length - 6);
		if (kind === "crc") input.writeUInt32LE((input.readUInt32LE(directory + 16) ^ 1) >>> 0, directory + 16);
		else input.writeUInt32LE(0xa0000000, directory + 38);
		await assert.rejects(inspectOfficeZip(input, "docx"), (error: unknown) => {
			return (
				error instanceof DocumentPreviewError &&
				error.code === (kind === "crc" ? "INVALID_DOCUMENT" : "UNSAFE_DOCUMENT")
			);
		});
	}
});

test("Office normalization bounds UTF-8 name expansion per entry and across the archive", async () => {
	// CP437 box-drawing bytes become three-byte UTF-8 names. They fit in the
	// input but must not overflow a generated 16-bit length or the metadata cap.
	const longName = documentZip("descriptor", [...documentParts, [Buffer.alloc(22_000, 0xb3), ""]]);
	assert.ok(longName.length < DOCUMENT_LIMITS.inputBytes);
	await assert.rejects(inspectOfficeZip(longName, "docx"), { code: "DOCUMENT_LIMIT" });
	const parts = Array.from({ length: 140 }, (_, index): readonly [Buffer, string] => [
		Buffer.concat([Buffer.alloc(20_000, 0xb3), Buffer.from(String(index))]),
		"",
	]);
	const manyNames = documentZip("descriptor", [...documentParts, ...parts]);
	assert.ok(manyNames.length < DOCUMENT_LIMITS.inputBytes);
	await assert.rejects(inspectOfficeZip(manyNames, "docx"), { code: "DOCUMENT_LIMIT" });
});
