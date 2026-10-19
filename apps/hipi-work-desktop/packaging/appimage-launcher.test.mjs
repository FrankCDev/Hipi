import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import verification from "./verify-appimage.cjs";

const launcher = await readFile(new URL("./AppRun", import.meta.url));
const listing = ["AppRun", "hipi-work.desktop"].map((name) => `Path = ${name}\nFolder = -\nMode = ${name === "AppRun" ? "-rwxr-xr-x" : "-rw-r--r--"}\nUser ID = 0\nGroup ID = 0`).join("\n\n");
const readEntry = (name) => name === "AppRun" ? launcher : Buffer.from(verification.expectedDesktop("0.0.1"));

test("unreviewed reader and mirror overrides fail before package execution on every platform", () => {
	for (const key of ["ELECTRON_BUILDER_7ZIP_PATH", "electron_builder_7zip_path", "NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR", "npm_package_config_electron_builder_binaries_mirror", "ELECTRON_BUILDER_BINARIES_ALLOW_HTTP"]) {
		assert.throws(() => verification.assertToolEnvironment({ [key]: "/untrusted" }), /tool override is forbidden/);
	}
	verification.assertToolEnvironment({ PATH: "/ordinary", ELECTRON_BUILDER_CACHE: "/reviewed" });
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/package-release.mjs", import.meta.url))], {
		env: { ...process.env, ELECTRON_BUILDER_7ZIP_PATH: "/must-not-execute" }, encoding: "utf8", timeout: 10_000,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unreviewed packaging tool override is forbidden/);
});

test("AppImage verifier requires full reviewed content, regular modes, root ownership and unique entries", () => {
	verification.assertLauncherEntries(listing, readEntry, "0.0.1");
	for (const altered of [listing.replace("-rwxr-xr-x", "-rwsr-xr-x"), listing.replace("User ID = 0", "User ID = 1000"), `${listing}\n\n${listing}`, listing.replace("Path = AppRun", "Path = absent")]) {
		assert.throws(() => verification.assertLauncherEntries(altered, readEntry, "0.0.1"));
	}
	for (const target of ["AppRun", "hipi-work.desktop"]) {
		assert.throws(() => verification.assertLauncherEntries(listing, (name) => name === target ? Buffer.concat([readEntry(name), Buffer.from("\n--no-sandbox\n")]) : readEntry(name), "0.0.1"));
	}
});

test("strict launcher preserves quoted arguments and host failure without probing or retrying", { skip: process.platform !== "linux" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "Hipi 启动 test "));
	try {
		await writeFile(join(directory, "AppRun"), launcher, { mode: 0o755 });
		await writeFile(join(directory, "hipi-work"), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 73\n', { mode: 0o755 });
		// A deliberately unrelated inherited APPDIR cannot redirect execution.
		const run = (args) => spawnSync("/bin/sh", [join(directory, "AppRun"), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", APPDIR: "/absent" }, timeout: 5000 });
		const normal = run(["中文 with spaces", "--provider=deterministic"]);
		assert.equal(normal.status, 73);
		assert.equal(normal.stdout, "中文 with spaces\n--provider=deterministic\n");
		await writeFile(join(directory, "readlink"), "#!/bin/sh\nexit 41\n", { mode: 0o755 });
		const resolutionFailure = spawnSync("/bin/sh", [join(directory, "AppRun")], {
			cwd: directory, env: { PATH: `${directory}:/usr/bin:/bin` }, encoding: "utf8", timeout: 5000,
		});
		assert.equal(resolutionFailure.status, 41);
		assert.equal(resolutionFailure.stdout, "");
		for (const forbidden of ["--no-sandbox", "--no-sandbox=true", "--disable-setuid-sandbox", "--disable-gpu-sandbox", "--single-process", "--in-process-gpu"]) {
			const result = run([forbidden]);
			assert.equal(result.status, 64);
			assert.equal(result.stdout, "");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
