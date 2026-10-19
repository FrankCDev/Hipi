import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { click } from "./gui-flow.mjs";
import {
	nativeLogLimit,
	readNativeLog,
	recordGuiFailure,
	recordRendererError,
	redactNativeLog,
	withNativeLogBudget,
} from "./gui-native-log.mjs";

test("Chromium timestamp envelopes preserve safe error text without exposing paths or environment", () => {
	for (const envelope of [
		"[4440:1019/231817.849:ERROR:dbus/bus.cc:408]",
		"[4440:4441:1019/231817.849123:ERROR:bus.cc(408)]",
	]) {
		assert.equal(redactNativeLog(`${envelope} Font decode failed`, []), "[Chromium ERROR] Font decode failed");
		assert.equal(
			redactNativeLog(`${envelope} Cannot open /home/private-user/font.woff2`, []),
			"[Chromium ERROR] Cannot open <absolute-path>",
		);
		assert.equal(
			redactNativeLog(`${envelope} HOME=/home/private-user`, []),
			"[Chromium ERROR] <redacted-sensitive-line>",
		);
	}
	assert.ok(!redactNativeLog("[4440:1019/private-user] unsafe", []).includes("private-user"));
});

test("shared evidence writers redact failures, cleanup and renderer details without losing click diagnostics", async () => {
	const evidence = { errors: [] };
	recordGuiFailure(evidence, "failure", new Error("EACCES open C:\\Users\\private-user\\secret.log"), []);
	recordGuiFailure(evidence, "cleanupFailure", new Error("Error inspecting /home/private-user/secret.log"), []);
	recordRendererError(
		evidence,
		0,
		"Runtime.exceptionThrown",
		{ description: "TypeError at /Users/private-user/secret.js" },
		[],
	);
	assert.ok(!JSON.stringify(evidence).includes("private-user"));
	assert.ok(evidence.failure.includes("EACCES"));
	assert.ok(evidence.cleanupFailure.includes("Error inspecting"));
	assert.ok(evidence.errors[0].detail.includes("TypeError"));
	recordGuiFailure(evidence, "failure", { message: "must-not-read" }, []);
	assert.equal(evidence.failure, "Unknown native failure");
	try {
		await click(
			{ request: async () => ({ result: { value: { count: 1, hit: false } } }) },
			'[role="dialog"] button',
			"Close",
			1,
		);
		assert.fail("Covered Close must fail");
	} catch (error) {
		recordGuiFailure(evidence, "failure", error, []);
	}
	assert.match(evidence.failure, /label "Close"; candidates 1, centerHit false/);
	for (let index = 1; index < 50; index++)
		recordRendererError(evidence, 0, "Log.entryAdded", { text: "ordinary diagnostic" }, []);
	assert.throws(() => recordRendererError(evidence, 0, "Log.entryAdded", {}, []), /overflow/);
});

test("file and stdout redaction removes unknown user paths and environment values while preserving error categories", () => {
	for (const path of [
		String.raw`C:\Users\runneradmin\AppData\private file`,
		"c:/USERS/runneradmin/private file",
		String.raw`\\server\runneradmin\private`,
		"/Users/runneradmin/private file",
		"/home/runneradmin/private",
		"file:///C:/Users/runneradmin/private",
	]) {
		const value = redactNativeLog(`TypeError: bootstrap failed at ${path}`, []);
		assert.ok(value.startsWith("TypeError: bootstrap failed at "));
		assert.ok(!value.includes("runneradmin") && !value.includes("private"));
	}
	for (const line of [
		"HOME=/home/runner",
		"PATH=C:\\Users\\runner",
		"unfamiliar_variable=private-value",
		"Error: credential=private-value",
		"EACCES token=private-value",
	]) {
		const value = redactNativeLog(line, []);
		assert.ok(value.startsWith("<redacted-sensitive-line>"));
		assert.ok(!value.includes("private-value") && !value.includes("runner"));
	}
	assert.equal(redactNativeLog("EACCES token=private-value", []), "<redacted-sensitive-line> EACCES");
	assert.equal(
		redactNativeLog("[ERROR:bootstrap.cc:42] Failed to initialize V8", []),
		"[ERROR:bootstrap.cc:42] Failed to initialize V8",
	);
});

test("native log reads only fixed owned files, bounds output and redacts sensitive lines", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "hipi-native-log-")));
	try {
		assert.equal((await readNativeLog(root, 0, [root])).exists, false);
		await writeFile(
			join(root, "chromium-0.log"),
			`${root}\nws://127.0.0.1:123/devtools/browser/secret\napi_key=secret\nbootstrap failed`,
		);
		const result = await readNativeLog(root, 0, [root]);
		assert.ok(!result.text.includes(root));
		assert.ok(!result.text.includes("secret"));
		assert.ok(result.text.includes("bootstrap failed"));
		await writeFile(join(root, "chromium-0.log"), Buffer.alloc(nativeLogLimit + 10, 65));
		const large = await readNativeLog(root, 0, [root]);
		assert.equal(large.overflow, true);
		assert.ok(Buffer.byteLength(large.text) <= nativeLogLimit);
		await assert.rejects(readNativeLog(root, 2, []));
		await rm(join(root, "chromium-0.log"));
		await symlink(root, join(root, "chromium-0.log"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(readNativeLog(root, 0, []), /owned regular file/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native log overflow and observation failure reject an active operation", async () => {
	for (const check of [
		async () => ({ overflow: true }),
		async () => {
			throw new Error("read denied");
		},
	]) {
		await assert.rejects(withNativeLogBudget(() => new Promise(() => {}), check));
	}
	assert.equal(
		await withNativeLogBudget(
			async () => "completed",
			async () => ({ overflow: false }),
		),
		"completed",
	);
});
