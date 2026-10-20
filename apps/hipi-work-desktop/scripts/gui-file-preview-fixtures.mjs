// Original bounded synthetic documents; source-only and never production-bundled.
import { crc32 } from "node:zlib";
import * as XLSX from "xlsx";

export const previewFixture = Object.freeze({
	docxName: "plain.docx",
	xlsxName: "saved-values.xlsx",
	pdfName: "painted.pdf",
	unsupportedName: "unsupported.html",
	docxText: "Original Word 中文 text\n\nLiteral <not-markup> & plain text\n\n",
	sheetName: "Saved values",
	secondSheetName: "Second sheet",
});

// Minimal STORE ZIP with fixed metadata. There are no network links or embedded objects.
function makeDocx() {
	const entries = [
		[
			"[Content_Types].xml",
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		],
		[
			"_rels/.rels",
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		],
		[
			"word/document.xml",
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Original Word 中文 text</w:t></w:r></w:p><w:p><w:r><w:t>Literal &lt;not-markup&gt; &amp; plain text</w:t></w:r></w:p></w:body></w:document>',
		],
	];
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [path, text] of entries) {
		const name = Buffer.from(path);
		const bytes = Buffer.from(text);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(33, 12);
		local.writeUInt32LE(crc32(bytes), 14);
		local.writeUInt32LE(bytes.length, 18);
		local.writeUInt32LE(bytes.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(20, 4);
		local.copy(central, 6, 4, 30);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, bytes);
		centrals.push(central, name);
		offset += local.length + name.length + bytes.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

function makeXlsx() {
	const workbook = XLSX.utils.book_new();
	const fixed = new Date("2000-01-01T00:00:00.000Z");
	workbook.Props = { CreatedDate: fixed, ModifiedDate: fixed, Author: "Synthetic fixture" };
	const sheet = XLSX.utils.aoa_to_sheet([
		["label", "value"],
		["中文", 42],
		["cached formula", 999],
	]);
	// Deliberately not 2: the viewer must display the saved value, never recalculate 1+1.
	sheet.B3 = { t: "n", f: "1+1", v: 999 };
	XLSX.utils.book_append_sheet(workbook, sheet, previewFixture.sheetName);
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			["second", "page"],
			["fixture", "unchanged"],
		]),
		previewFixture.secondSheetName,
	);
	return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
}

function makePdf() {
	const paint = "BT /F1 24 Tf 40 220 Td (Hipi PDF Preview) Tj ET 0 0 1 rg 40 100 100 50 re f";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
	];
	let source = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(source));
		source += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(source);
	source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
	source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(source);
}

export function createPreviewFixtureFiles() {
	return [
		[previewFixture.docxName, makeDocx()],
		[previewFixture.xlsxName, makeXlsx()],
		[previewFixture.pdfName, makePdf()],
		[previewFixture.unsupportedName, Buffer.from("<!doctype html><p>Inert unsupported preview fixture</p>\n")],
	];
}
