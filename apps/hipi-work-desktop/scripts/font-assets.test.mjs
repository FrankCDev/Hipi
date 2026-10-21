import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRendererAssetHandler } from "../src/shell/renderer-assets.ts";
import { assertFontAsset, fontAssets } from "./font-assets.mjs";
import { allowedPayload, requiredFiles } from "./release-policy.mjs";

const ui = new URL("../../hipi-work-ui/", import.meta.url);
test("only reviewed font, original OFL and manifest can ship; tampering fails closed", async () => {
	for (const asset of fontAssets) {
		const bytes = await readFile(new URL(asset.source, ui));
		assertFontAsset(asset.payload, bytes);
		assert.ok(requiredFiles.includes(asset.payload));
		assert.equal(allowedPayload(asset.payload), true);
		const changed = Buffer.from(bytes);
		changed[changed.length - 1] ^= 1;
		assert.throws(() => assertFontAsset(asset.payload, changed), /digest mismatch/);
	}
	for (const path of [
		"dist/renderer/assets/other.woff2",
		"dist/renderer/assets/hipi-noto-sc-aef8c342.ttf",
		"dist/third-party/fonts/other.json",
	])
		assert.equal(allowedPayload(path), false);
	assert.throws(() => assertFontAsset("dist/renderer/assets/other.woff2", Buffer.from("wOF2")), /Unreviewed/);
});
test("local protocol serves exact WOFF2 bytes and self-only fonts, without remote access", async () => {
	const serve = createRendererAssetHandler(fileURLToPath(new URL("vendor/fonts/public/", ui)));
	const url = "hipi-work://app/assets/hipi-noto-sc-aef8c342.woff2";
	const response = await serve({ url, method: "GET" });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "font/woff2");
	assert.match(response.headers.get("Content-Security-Policy"), /font-src 'self';/);
	assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'none';/);
	assertFontAsset(fontAssets[0].payload, Buffer.from(await response.arrayBuffer()));
	assert.equal((await serve({ url: url.replace("hipi-work:", "https:"), method: "GET" })).status, 403);
});
test("upstream coverage is explicit rather than a claim of all Unicode", async () => {
	const manifest = JSON.parse(await readFile(new URL("vendor/fonts/source-manifest.json", ui), "utf8"));
	assert.equal(manifest.cmapEquivalent, true);
	assert.equal(manifest.codepointCount, 30890);
	assert.equal(manifest.basicHanCount, 20976);
	assert.equal(manifest.basicHanMissing.length, 16);
	assert.equal(manifest.recalcTimestamp, false);
	const coverage = new Set();
	for (const range of manifest.sourceCmapRanges) {
		const [first, last = first] = range.slice(2).split("-");
		for (let n = Number.parseInt(first, 16); n <= Number.parseInt(last, 16); n++) coverage.add(n);
	}
	assert.equal(coverage.size, manifest.codepointCount);
	for (const character of "真实桌面中文流式验证工作区会话权限繁體龍龜")
		assert.ok(coverage.has(character.codePointAt(0)));
	assert.equal(coverage.has(0x9ff0), false);
});
