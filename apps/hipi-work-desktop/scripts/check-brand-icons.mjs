import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const branding = resolve(root, "branding");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsTypes = new Map([
	["icp4", 16],
	["icp5", 32],
	["icp6", 64],
	["ic07", 128],
	["ic08", 256],
	["ic09", 512],
	["ic10", 1024],
]);
const inventory = JSON.parse(await readFile(resolve(branding, "asset-inventory.json"), "utf8"));
assert.equal(inventory.schemaVersion, 1);
assert.equal(inventory.source, "icon.svg");
assert.deepEqual(inventory.pngSizes, sizes);
assert.deepEqual(inventory.icoSizes, icoSizes);
assert.deepEqual(inventory.icnsSizes, [...icnsTypes.values()]);
const expected = ["icon.svg", "icon.ico", "icon.icns", ...sizes.map((size) => `png/${size}x${size}.png`)];
assert.deepEqual(
	inventory.files.map((entry) => entry.file),
	expected,
);
const assets = new Map();
for (const entry of inventory.files) {
	const bytes = await readFile(resolve(branding, entry.file));
	assert.equal(bytes.length, entry.bytes, `${entry.file}: byte length`);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.file}: hash`);
	assets.set(entry.file, bytes);
}
for (const size of sizes) {
	const bytes = assets.get(`png/${size}x${size}.png`);
	assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
	assert.equal(bytes.readUInt32BE(16), size);
	assert.equal(bytes.readUInt32BE(20), size);
	assert.equal(bytes[24], 8, "8-bit channels");
	assert.equal(bytes[25], 6, "RGBA transparency");
}
const ico = assets.get("icon.ico");
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), icoSizes.length);
let icoOffset = 6 + 16 * icoSizes.length;
for (const [index, size] of icoSizes.entries()) {
	const entry = 6 + index * 16;
	const png = assets.get(`png/${size}x${size}.png`);
	assert.equal(ico[entry] || 256, size);
	assert.equal(ico[entry + 1] || 256, size);
	assert.equal(ico.readUInt16LE(entry + 4), 1);
	assert.equal(ico.readUInt16LE(entry + 6), 32);
	assert.equal(ico.readUInt32LE(entry + 8), png.length);
	assert.equal(ico.readUInt32LE(entry + 12), icoOffset);
	assert.deepEqual(ico.subarray(icoOffset, icoOffset + png.length), png);
	icoOffset += png.length;
}
assert.equal(icoOffset, ico.length);
const icns = assets.get("icon.icns");
assert.equal(icns.toString("ascii", 0, 4), "icns");
assert.equal(icns.readUInt32BE(4), icns.length);
let icnsOffset = 8;
for (const [kind, size] of icnsTypes) {
	const png = assets.get(`png/${size}x${size}.png`);
	assert.equal(icns.toString("ascii", icnsOffset, icnsOffset + 4), kind);
	assert.equal(icns.readUInt32BE(icnsOffset + 4), png.length + 8);
	assert.deepEqual(icns.subarray(icnsOffset + 8, icnsOffset + 8 + png.length), png);
	icnsOffset += png.length + 8;
}
assert.equal(icnsOffset, icns.length);
const svg = assets.get("icon.svg").toString("utf8");
const component = await readFile(resolve(root, "../hipi-work-ui/src/components/brand-mark.tsx"), "utf8");
const paths = [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
assert.equal(paths.length, 2);
for (const path of paths) assert.ok(component.includes(`d="${path}"`), "BrandMark geometry must match SVG");
assert.ok(component.includes('aria-hidden="true"'));
assert.ok(component.includes('focusable="false"'));
console.log(`Brand assets verified: ${sizes.length} RGBA PNG sizes, ICO, ICNS, hashes and UI geometry`);
