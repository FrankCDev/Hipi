const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile, readdir } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const asarLookupPath = require("./asar-path.cjs");
// Use the packager's own exact ASAR reader, not an independently versioned toolchain.
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const { extractFile, listPackage, statFile } = builderRequire("@electron/asar");

module.exports = async function verifyPack(context) {
	const resources = context.electronPlatformName === "darwin"
		? path.join(context.appOutDir, "Hipi Work.app/Contents/Resources")
		: path.join(context.appOutDir, "resources");
	const archive = path.join(resources, "app.asar");
	const provenance = JSON.parse(extractFile(archive, "build-provenance.json").toString("utf8"));
	const expected = new Set([...provenance.payload.map((item) => item.file), "build-provenance.json"]);
	const files = listPackage(archive).map((file) => file.replaceAll("\\", "/").replace(/^\//, ""))
		.filter((file) => !statFile(archive, asarLookupPath(file)).files);
	assert.deepEqual(new Set(files), expected, "ASAR contains missing/unexpected files");
	for (const item of provenance.payload) {
		const bytes = extractFile(archive, asarLookupPath(item.file));
		assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, `Packaged digest: ${item.file}`);
	}
	for (const file of ["runtime.mjs", "preview-parser.mjs", "maintenance.mjs"]) {
		const bytes = await readFile(path.join(resources, "app.asar.unpacked/dist", file));
		const record = provenance.payload.find((item) => item.file === `dist/${file}`);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
	}
	assert.deepEqual((await readdir(path.join(resources, "app.asar.unpacked/dist"))).sort(), ["maintenance.mjs", "preview-parser.mjs", "runtime.mjs"]);
	console.log("Verified packaged ASAR allowlist, all payload digests, and unpacked utility/parser/maintenance entries.");
};
