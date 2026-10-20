const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { portableExecutables } = require("./verify-linux-sandbox.cjs");
const { assertAppImageCriticalFiles } = require("./verify-linux-artifacts.cjs");

function assertToolEnvironment(environment) {
	for (const key of Object.keys(environment)) {
		if (/^(?:ELECTRON_BUILDER_7ZIP_PATH|(?:NPM_CONFIG_|NPM_PACKAGE_CONFIG_)?ELECTRON_BUILDER_BINARIES_MIRROR|ELECTRON_BUILDER_BINARIES_ALLOW_HTTP)$/i.test(key))
			throw new Error(`Unreviewed packaging tool override is forbidden: ${key}`);
	}
}

function expectedDesktop(version) {
	assert.match(version, /^[0-9A-Za-z.+-]+$/);
	return `[Desktop Entry]\nName=Hipi Work\nExec=AppRun %U\nTerminal=false\nType=Application\nIcon=hipi-work\nStartupWMClass=hipi-work\nX-AppImage-Version=${version}\nComment=Hipi Work desktop unsigned staging build\nCategories=Utility;\n`;
}

function assertLauncherEntries(listing, readEntry, version) {
	const sections = listing.split(/\r?\n\r?\n/);
	for (const [name, mode, expected] of [
		["AppRun", "-rwxr-xr-x", readFileSync(path.join(__dirname, "AppRun"))],
		["hipi-work.desktop", "-rw-r--r--", Buffer.from(expectedDesktop(version))],
		...portableExecutables.map((name) => [name, "-rwxr-xr-x", null]),
	]) {
		const entries = sections.filter((section) => section.split(/\r?\n/).includes(`Path = ${name}`));
		assert.equal(entries.length, 1, `Unique regular AppImage entry required: ${name}`);
		const lines = entries[0].split(/\r?\n/);
		for (const field of [`Path = ${name}`, `Mode = ${mode}`, "Folder = -", "User ID = 0", "Group ID = 0"]) {
			const key = field.slice(0, field.indexOf(" = ") + 3);
			assert.deepEqual(lines.filter((line) => line.startsWith(key)), [field], `Unsafe AppImage metadata: ${name}: ${field}`);
		}
		if (expected !== null)
			assert.deepEqual(readEntry(name), expected, `Unreviewed AppImage launcher/desktop: ${name}`);
	}
}

function verifyAppImage(archive, version, reader, criticalFiles = []) {
	// Read archive bytes through the packager's pinned 7zip tool, never execute AppImage/AppRun.
	const options = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
	const listing = execFileSync(reader, ["l", "-slt", archive], options).toString("utf8");
	assertLauncherEntries(listing, (name) => execFileSync(reader, ["x", "-so", archive, name], options), version);
	assertAppImageCriticalFiles(listing, (name, bytes) => {
		assert.ok(bytes < 512 * 1024 * 1024, "Critical AppImage payload exceeds read budget");
		return execFileSync(reader, ["x", "-so", archive, name], { ...options, maxBuffer: bytes + 1 });
	}, criticalFiles);
	console.log("Verified actual AppImage launcher/desktop bytes and portable executable modes/ownership; no sandbox fallback.");
}

module.exports = { assertLauncherEntries, assertToolEnvironment, expectedDesktop, verifyAppImage };
