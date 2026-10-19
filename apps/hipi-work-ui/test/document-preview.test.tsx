import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { DocumentPage } from "../src/features/files/document-preview.tsx";
import { PDF_LOCAL_ASSETS } from "../src/features/files/pdf-assets.generated.ts";
import { LocalPdfData } from "../src/features/files/pdf-local-data.ts";
import { boundedPdfSize, PDF_PIXEL_LIMIT } from "../src/features/files/pdf-preview.tsx";

test("DOCX text is escaped and lossy fidelity is explicit", () => {
	const html = renderToStaticMarkup(
		<DocumentPage
			locale="en"
			content={{
				kind: "document",
				format: "docx",
				text: '<img src="https://attacker.invalid/a" onerror="alert(1)">',
				truncated: true,
				limitations: [],
			}}
		/>,
	);
	assert.match(html, /&lt;img/);
	assert.doesNotMatch(html, /<img|<script|<iframe/);
	assert.match(html, /Plain-text Word preview/);
	assert.match(html, /Limited preview/);
});
test("grid displays only escaped saved text, never executable formulas or hyperlinks", () => {
	const html = renderToStaticMarkup(
		<DocumentPage
			locale="en"
			content={{
				kind: "spreadsheet",
				format: "xlsx",
				truncated: false,
				limitations: [],
				sheets: [
					{
						name: "Sheet 1",
						rows: [
							[{ type: "string", value: "=HYPERLINK()", display: '<a href="https://attacker.invalid">value</a>' }],
						],
					},
				],
			}}
		/>,
	);
	assert.match(html, /Formulas are not recalculated/);
	assert.match(html, /&lt;a href/);
	assert.doesNotMatch(html, /<a |HYPERLINK|<iframe/);
});
test("PDF canvas size rejects nonfinite, oversized and pathological aspect ratios", () => {
	assert.deepEqual(boundedPdfSize(600, 800), { width: 600, height: 800 });
	for (const dimensions of [
		[0, 100],
		[NaN, 2],
		[Infinity, 1],
		[4001, 4000],
		[20000, 1],
	]) {
		assert.throws(() => boundedPdfSize(dimensions[0] ?? 0, dimensions[1] ?? 0));
	}
	const result = boundedPdfSize(4000, 4000);
	assert.equal(result.width * result.height, PDF_PIXEL_LIMIT);
});
test("all 182 PDF assets are actually inline, bounded and match the reviewed binary inventory", async () => {
	const inventory: {
		assets: { file: string; bytes: number; sha256: string }[];
		licenseFiles: string[];
		totalBytes: number;
	} = JSON.parse(await readFile(new URL("../vendor/pdfjs/asset-inventory.json", import.meta.url), "utf8"));
	const factory = new LocalPdfData();
	let count = 0,
		total = 0;
	for (const [kind, resources] of Object.entries(PDF_LOCAL_ASSETS)) {
		for (const filename of Object.keys(resources)) {
			const bytes = await factory.fetch({ kind, filename });
			const expected = inventory.assets.find(
				(asset) => asset.file === `${kind === "cMapUrl" ? "cmaps" : "standard_fonts"}/${filename}`,
			);
			assert.ok(expected);
			assert.equal(bytes.byteLength, expected.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
			total += bytes.byteLength;
			count++;
		}
	}
	assert.equal(count, 182);
	assert.equal(total, inventory.totalBytes);
	for (const license of inventory.licenseFiles)
		assert.ok((await readFile(new URL(`../vendor/pdfjs/${license}`, import.meta.url), "utf8")).length > 100);
});
test("PDF resource requests cannot become network URLs, traversal, WASM or prototype lookups", async () => {
	const factory = new LocalPdfData();
	for (const filename of [
		"../LICENSE",
		"https://attacker.invalid/font.ttf",
		"__proto__",
		"constructor",
		"Unknown.bcmap",
	]) {
		await assert.rejects(factory.fetch({ kind: "cMapUrl", filename }));
	}
	await assert.rejects(factory.fetch({ kind: "wasmUrl", filename: "openjpeg.wasm" }));
	await assert.rejects(factory.fetch({ kind: "iccUrl", filename: "profile.icc" }));
});
