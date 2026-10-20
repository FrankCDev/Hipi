const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { lstat, readFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pin } = require("./linux-maintenance.cjs");
const { portableExecutables } = require("./verify-linux-sandbox.cjs");
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const tar = builderRequire("tar");

async function linuxCriticalFiles(directory) {
	const modes = [
		...[...portableExecutables, "AppRun", "hipi-work-maintenance"].map((file) => ({ file, mode: 0o755 })),
		{ file: "resources/app.asar", mode: 0o644 },
		...["runtime.mjs", "preview-parser.mjs", "maintenance.mjs"].map((file) => ({ file: `resources/app.asar.unpacked/dist/${file}`, mode: 0o644 })),
		...pin.files.map(({ file, mode }) => ({ file: `resources/maintenance-runtime/${file}`, mode })),
		{ file: "resources/maintenance-runtime/provenance.json", mode: 0o644 },
	];
	return Promise.all(modes.map(async ({ file, mode }) => {
		const location = path.join(directory, file);
		const stat = await lstat(location);
		assert.ok(stat.isFile() && stat.nlink === 1, `Expected regular critical payload: ${file}`);
		assert.equal(stat.mode & 0o7777, mode, `Unexpected critical payload mode: ${file}`);
		const bytes = await readFile(location);
		return { file, mode, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	}));
}

function assertAppImageCriticalFiles(listing, readEntry, expected) {
	const sections = listing.split(/\r?\n\r?\n/);
	for (const item of expected) {
		const entries = sections.filter((section) => section.split(/\r?\n/).includes(`Path = ${item.file}`));
		assert.equal(entries.length, 1, `Unique critical AppImage entry required: ${item.file}`);
		const lines = entries[0].split(/\r?\n/);
		assert.ok([0o755, 0o644].includes(item.mode), "Unreviewed critical file mode");
		for (const field of [`Path = ${item.file}`, `Mode = ${item.mode === 0o755 ? "-rwxr-xr-x" : "-rw-r--r--"}`, "Folder = -", "User ID = 0", "Group ID = 0", `Size = ${item.bytes}`]) {
			const key = field.slice(0, field.indexOf(" = ") + 3);
			assert.deepEqual(lines.filter((line) => line.startsWith(key)), [field], `Unsafe critical AppImage metadata: ${item.file}`);
		}
		const bytes = readEntry(item.file, item.bytes);
		assert.equal(bytes.length, item.bytes, `AppImage critical size: ${item.file}`);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, `AppImage critical digest: ${item.file}`);
	}
}

function verifyLinuxTar(archive, expected, productionVersion) {
	const prefix = path.basename(archive, ".tar.gz");
	if (productionVersion === undefined) assert.match(prefix, /^Hipi-Work-[0-9A-Za-z.+-]+-linux-x64-unsigned$/);
	else {
		assert.match(productionVersion, /^[1-9]\d*\.\d+\.\d+$/);
		assert.equal(prefix, `Hipi-Work-${productionVersion}-linux-x64`);
	}
	const seen = new Set();
	const verified = new Set();
	// The builder's locked tar reader parses streams without extracting or
	// executing entries. Synchrony keeps callback failures within this gate.
	tar.t({ file: archive, sync: true, strict: true, onReadEntry(entry) {
		const name = entry.path.replace(/\/$/, "");
		assert.ok(name === prefix || name.startsWith(`${prefix}/`), "Tar entry escaped its expected package root");
		assert.equal(path.posix.normalize(name), name, "Tar entry has ambiguous path components");
		assert.ok(!name.includes("\\") && !name.split("/").includes(".."), "Unsafe tar entry path");
		assert.equal(seen.has(name), false, `Duplicate tar entry: ${name}`);
		seen.add(name);
		assert.ok(["File", "OldFile", "Directory"].includes(entry.type), `Unexpected tar entry type: ${name}`);
		const item = expected.find((value) => `${prefix}/${value.file}` === name);
		if (!item) return;
		assert.ok(["File", "OldFile"].includes(entry.type), `Critical tar entry is not a file: ${name}`);
		// builder 26.15.3 uses node-tar's portable mode: ownership fields are
		// omitted, not an installed root-ownership claim. GNU tar displays these
		// as 0/0, while the locked reader correctly reports no stored owner.
		assert.equal(entry.uid, undefined, `Unexpected portable tar uid: ${name}`);
		assert.equal(entry.gid, undefined, `Unexpected portable tar gid: ${name}`);
		assert.ok(!entry.uname && !entry.gname, `Unexpected portable tar owner name: ${name}`);
		assert.equal(entry.mode, item.mode, `Critical tar mode: ${name}`);
		assert.equal(entry.size, item.bytes, `Critical tar size: ${name}`);
		const hash = createHash("sha256");
		entry.on("data", (chunk) => hash.update(chunk));
		entry.on("end", () => {
			assert.equal(hash.digest("hex"), item.sha256, `Critical tar digest: ${name}`);
			verified.add(item.file);
		});
	} });
	assert.deepEqual(verified, new Set(expected.map((item) => item.file)), "Tar critical payload is incomplete");
}

module.exports = { assertAppImageCriticalFiles, linuxCriticalFiles, verifyLinuxTar };
