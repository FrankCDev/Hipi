import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { prepareDesktopLaunch, smokeProfile } from "../src/smoke-profile.ts";

test("production defaults are untouched and test flags are rejected", () => {
	assert.equal(smokeProfile([], "production"), undefined);
	assert.throws(() => smokeProfile(["--smoke-data-root=/tmp/anything"], "production"));
	assert.throws(() => smokeProfile(["--smoke-data-root"], "deterministic"));
});

test("main entrypoint rejects invalid isolation before lock/session and passes the prepared mode to start", () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const begin = source.indexOf("let launch: ReturnType<typeof prepareDesktopLaunch>");
	const end = source.indexOf("\nasync function start(", begin);
	assert.ok(begin > 0 && end > begin, "Main launch boundary must remain explicit");
	assert.ok(!source.includes("app.requestSingleInstanceLock("), "Main must use the tested startup boundary");
	const entry = stripTypeScriptTypes(source.slice(begin, end));
	for (const scenario of ["production", "invalid", "secondary"] as const) {
		const events: string[] = [];
		const app = {
			setPath() {
				throw new Error("Unexpected path override");
			},
			getPath() {
				throw new Error("Unexpected default path access");
			},
			requestSingleInstanceLock() {
				events.push("lock");
				return scenario !== "secondary";
			},
			exit(code: number) {
				events.push(`exit:${code}`);
			},
		};
		runInNewContext(entry, {
			prepareDesktopLaunch,
			app,
			process: { argv: scenario === "invalid" ? ["--smoke-data-root=/not-owned"] : [] },
			diagnostics: { record: (code: string) => events.push(code) },
			exporter: { close: () => events.push("exporter:close") },
			dialog: { showErrorBox: () => events.push("error:visible") },
			hostMessages: () => ({ "host.startup.failed": "failed" }),
			start: async (mode: string) => {
				events.push(`start:${mode}`);
			},
		});
		assert.deepEqual(
			events,
			scenario === "invalid"
				? ["HOST_STARTUP_FAILED", "exporter:close", "error:visible", "exit:1"]
				: scenario === "secondary"
					? ["lock", "exit:0"]
					: ["lock", "start:production"],
		);
	}
});
test("only a private canonical dedicated temporary directory is accepted; reopen keeps data", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI profile-")));
	try {
		const args = [`--smoke-data-root=${root}`];
		const paths = smokeProfile(args, "deterministic");
		assert.ok(paths);
		writeFileSync(join(paths.userData, "sentinel"), "keep");
		assert.deepEqual(smokeProfile(args, "deterministic"), paths);
		assert.throws(() => smokeProfile([...args, ...args], "deterministic"));
		assert.throws(() => smokeProfile([`--smoke-data-root=${root}/../${root.split(/[\\/]/).at(-1)}`], "deterministic"));
		writeFileSync(join(root, "unowned"), "reject");
		assert.throws(() => smokeProfile(args, "deterministic"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("reject a symlink/junction profile child rather than writing outside the root", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI profile-")));
	const target = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI target-")));
	try {
		symlinkSync(target, join(root, "profile"), process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => smokeProfile([`--smoke-data-root=${root}`], "deterministic"));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("actual launch boundary applies and verifies paths before acquiring the single-instance lock", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI profile-")));
	const events: string[] = [];
	const paths = new Map<string, string>();
	const app = {
		setPath(name: string, path: string) {
			events.push(`set:${name}`);
			paths.set(name, path);
		},
		getPath(name: string) {
			events.push(`get:${name}`);
			return paths.get(name) ?? "missing";
		},
		requestSingleInstanceLock() {
			events.push("lock");
			return true;
		},
	};
	try {
		assert.deepEqual(prepareDesktopLaunch(app, ["--provider=deterministic", `--smoke-data-root=${root}`]), {
			mode: "deterministic",
			hasLock: true,
		});
		assert.deepEqual(events, [
			"set:userData",
			"get:userData",
			"set:sessionData",
			"get:sessionData",
			"set:logs",
			"get:logs",
			"set:crashDumps",
			"get:crashDumps",
			"lock",
		]);
		events.length = 0;
		assert.deepEqual(prepareDesktopLaunch(app, []), { mode: "production", hasLock: true });
		assert.deepEqual(events, ["lock"]);
		events.length = 0;
		assert.throws(() => prepareDesktopLaunch(app, [`--smoke-data-root=${root}`]));
		assert.equal(events.length, 0);
		assert.throws(() =>
			prepareDesktopLaunch({ ...app, getPath: () => "wrong" }, [
				"--provider=deterministic",
				`--smoke-data-root=${root}`,
			]),
		);
		assert.ok(!events.includes("lock"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
