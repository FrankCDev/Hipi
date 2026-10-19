// Run only after explicitly authorized desktop preparation. Uses synthetic documents only.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { crc32 } from "node:zlib";

function zip(parts) {
	const entries = [];
	const directory = [];
	let offset = 0;
	for (const [nameText, text] of parts) {
		const name = Buffer.from(nameText);
		const data = Buffer.from(text);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		entries.push(local, name, data);
		directory.push(central, name);
		offset += local.length + name.length + data.length;
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
const docx = zip([
	[
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	],
	[
		"word/document.xml",
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Relocated fixture</w:t></w:r></w:p></w:body></w:document>',
	],
]);
const xlsx = zip([
	[
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
	],
	[
		"_rels/.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
	],
	[
		"xl/workbook.xml",
		'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>',
	],
	[
		"xl/_rels/workbook.xml.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
	],
	[
		"xl/worksheets/sheet1.xml",
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Relocated fixture</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
	],
]);
const metadata = JSON.parse(await readFile(new URL("../dist/preview-parser.meta.json", import.meta.url), "utf8"));
const forbidden = /(?:^|\/)(?:argparse|sprintf-js|node-forge|gondolin)(?:\/|$)/;
assert.ok(
	Object.keys(metadata.inputs).every((input) => !forbidden.test(input)),
	"Unneeded CLI or runtime dependencies reached parser bundle",
);
process.stdout.write("Parser bundle excludes argparse, sprintf-js, node-forge and gondolin.\n");
const directory = await mkdtemp(join(tmpdir(), "hipi-relocated-preview-"));
try {
	const entry = join(directory, "preview-parser.mjs");
	await copyFile(new URL("../dist/preview-parser.mjs", import.meta.url), entry);
	for (const [format, bytes] of [
		["csv", Buffer.from("Relocated fixture,42")],
		["docx", docx],
		["xlsx", xlsx],
	]) {
		const worker = new Worker(pathToFileURL(entry), { env: {}, stdout: true, stderr: true });
		worker.stdout.resume();
		worker.stderr.resume();
		let timer;
		try {
			const result = await new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Relocated parser timed out")), 10000);
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`Unexpected parser exit: ${code}`)));
				worker.once("message", resolve);
				worker.postMessage({ format, bytes: Uint8Array.from(bytes) });
			});
			assert.equal(result.ok, true, `Relocated ${format} parse failed`);
			assert.equal(result.preview.format, format);
			assert.ok(JSON.stringify(result.preview).includes("Relocated fixture"));
			process.stdout.write(`Relocated ${format} worker parse passed.\n`);
		} finally {
			clearTimeout(timer);
			await worker.terminate();
			worker.removeAllListeners();
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
