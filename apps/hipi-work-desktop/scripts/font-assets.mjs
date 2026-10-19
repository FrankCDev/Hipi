import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Deliberately pinned independently of the editable source manifest: no wildcard font payloads.
export const fontAssets = [
	{
		source: "vendor/fonts/public/assets/hipi-noto-sc-aef8c342.woff2",
		payload: "dist/renderer/assets/hipi-noto-sc-aef8c342.woff2",
		sha256: "aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a",
		bytes: 7782072,
	},
	{
		source: "vendor/fonts/OFL.txt",
		payload: "dist/third-party/fonts/OFL.txt",
		sha256: "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
	},
	{
		source: "vendor/fonts/source-manifest.json",
		payload: "dist/third-party/fonts/source-manifest.json",
		sha256: "cc43b9a3fd754a3238bfb9572980d939fc12cb917036d3bde99b8b1e2305fbbf",
	},
];
export function assertFontAsset(path, bytes) {
	const expected = fontAssets.find((item) => item.payload === path);
	assert.ok(expected, "Unreviewed font payload");
	assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, "Font asset digest mismatch");
	if (expected.bytes) {
		assert.equal(bytes.length, expected.bytes);
		assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2");
	}
}
export async function prepareFontAssets(ui, desktop) {
	for (const asset of fontAssets) assertFontAsset(asset.payload, await readFile(join(ui, asset.source)));
	await mkdir(join(desktop, "dist/third-party/fonts"), { recursive: true });
	for (const asset of fontAssets.filter((item) => !item.bytes))
		await cp(join(ui, asset.source), join(desktop, asset.payload));
	// The font itself is copied from the reviewed publicDir by Vite (also usable offline in development).
}
