import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

test("only six exact credential-status marker lines survive sensitive-line redaction", () => {
	for (const phase of [
		"status-enter",
		"availability-enter",
		"availability-return",
		"file-read-enter",
		"file-read-return",
		"status-return",
	]) {
		const marker = `[Hipi smoke credential-status] ${phase}`;
		assert.equal(redactNativeLog(marker, []), marker);
		for (const line of [
			` ${marker}`,
			`${marker} `,
			`private-payload ${marker}`,
			`${marker} private-payload`,
			`${marker} token=private-token`,
			`${marker} /home/private-user/file`,
			`[4440:1019/231817.849:ERROR:module.cc:408] ${marker}`,
		]) {
			const result = redactNativeLog(line, []);
			assert.ok(result.includes("<redacted-sensitive-line>"));
			assert.ok(!result.includes(marker) && !result.includes("private"));
		}
	}
	assert.equal(redactNativeLog("[Hipi smoke credential-status] private-phase", []), "<redacted-sensitive-line>");
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

test("aggregate failure diagnostics retain bounded redacted causes and allowlisted work-experience phases", () => {
	const acceptance = Object.assign(new Error("EACCES open C:\\Users\\private-user\\secret.log"), {
		workExperiencePhase: "settings",
		stack: "private-stack",
		stderr: "private-stderr",
	});
	const restoration = Object.assign(new Error("Error: token=private-token"), {
		workExperiencePhase: "restoration",
	});
	const error = new AggregateError([acceptance, restoration], "Work-experience acceptance and restoration failed");
	const evidence = {};
	recordGuiFailure(evidence, "failure", error, []);
	assert.equal(evidence.failure, error.message);
	assert.deepEqual(evidence.failureCauses, [
		{ message: "EACCES open <absolute-path>", phase: "settings" },
		{ message: "<redacted-sensitive-line> Error", phase: "restoration" },
	]);
	assert.ok(!JSON.stringify(evidence).includes("private"));
	const original = new Error("Original operation failed", { cause: acceptance });
	original.workExperiencePhase = "composer";
	recordGuiFailure(evidence, "cleanupFailure", original, []);
	assert.equal(evidence.cleanupFailure, original.message);
	assert.equal(evidence.cleanupFailurePhase, "composer");
	assert.deepEqual(evidence.cleanupFailureCauses, [evidence.failureCauses[0]]);
	recordGuiFailure(evidence, "cleanupFailure", new Error("Later operation failed"), []);
	assert.ok(!("cleanupFailurePhase" in evidence) && !("cleanupFailureCauses" in evidence));
	for (const phase of ["credential_open", "credential_close"]) {
		recordGuiFailure(
			evidence,
			"failure",
			Object.assign(new Error("Bounded step failed"), { workExperiencePhase: phase }),
			[],
		);
		assert.equal(evidence.failurePhase, phase);
	}
});

test("failure cause diagnostics cap depth, count and text, ignore cycles, getters and unknown phases", () => {
	let nested = new Error("outside-depth-bound");
	for (let index = 0; index < 4; index++) nested = new Error(`level-${index}`, { cause: nested });
	const evidence = {};
	recordGuiFailure(evidence, "failure", nested, []);
	assert.equal(evidence.failureCauses.length, 3);
	assert.ok(!JSON.stringify(evidence).includes("outside-depth-bound"));
	const cycle = new Error("cycle");
	cycle.cause = cycle;
	const getter = new Error("will-not-read");
	for (const property of ["message", "cause", "workExperiencePhase"])
		Object.defineProperty(getter, property, {
			get() {
				throw new Error("accessor must not run");
			},
		});
	const oversized = Object.assign(new Error("a".repeat(5000)), { workExperiencePhase: "private-unknown-phase" });
	recordGuiFailure(
		evidence,
		"failure",
		new AggregateError([cycle, getter, oversized, ...Array.from({ length: 10 }, () => new Error("bounded"))], "root"),
		[],
	);
	assert.equal(evidence.failureCauses.length, 6);
	assert.deepEqual(evidence.failureCauses[1], { message: "Unknown native failure" });
	assert.deepEqual(evidence.failureCauses[2], { message: "a".repeat(500) });
	assert.ok(!JSON.stringify(evidence).includes("private"));
	for (const error of [getter, Object.assign(new Error("will-not-read"), { message: { private: "object" } })]) {
		recordGuiFailure(evidence, "failure", error, []);
		assert.equal(evidence.failure, "Unknown native failure");
		assert.ok(!("failureCauses" in evidence));
	}
	recordGuiFailure(evidence, "failure", oversized, []);
	assert.equal(evidence.failure, "a".repeat(2000));
	assert.ok(!("failurePhase" in evidence));
});

test("cleanup command diagnostics expose only fixed categories and bounded PowerShell markers", () => {
	const evidence = {};
	for (const marker of [
		"PSSecurityException",
		"CommandNotFoundException",
		"CimException",
		"UnauthorizedAccessException",
	]) {
		const error = Object.assign(new Error("command=private-command"), {
			code: 1,
			stderr: `C:\\Users\\private-user\\private-script.ps1 ${marker}: token=private-token`,
		});
		recordGuiFailure(evidence, "cleanupFailure", error, []);
		assert.deepEqual(evidence.cleanupFailureCommand, { category: "nonzero-exit", powershellMarker: marker });
		assert.ok(!JSON.stringify(evidence).includes("private"));
	}
	for (const [properties, category] of [
		[{ code: "ETIMEDOUT" }, "timeout"],
		[{ code: null, killed: true, signal: "SIGTERM" }, "terminated"],
	]) {
		recordGuiFailure(evidence, "cleanupFailure", Object.assign(new Error("command=private"), properties), []);
		assert.deepEqual(evidence.cleanupFailureCommand, { category });
	}
	for (const code of [0, "unknown-private-code", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
		recordGuiFailure(
			evidence,
			"cleanupFailure",
			Object.assign(new Error("command=private"), { code, killed: true }),
			[],
		);
		assert.ok(!("cleanupFailureCommand" in evidence));
	}
	const error = Object.assign(new Error("command=private"), { code: 1 });
	for (const stderr of ["private-text UnknownPrivateException", `${"a".repeat(4096)} PSSecurityException`]) {
		error.stderr = stderr;
		recordGuiFailure(evidence, "cleanupFailure", error, []);
		assert.deepEqual(evidence.cleanupFailureCommand, { category: "nonzero-exit" });
	}
	Object.defineProperty(error, "stderr", { get: () => assert.fail("stderr getter must not run") });
	recordGuiFailure(evidence, "cleanupFailure", error, []);
	assert.deepEqual(evidence.cleanupFailureCommand, { category: "nonzero-exit" });
	const failure = {};
	recordGuiFailure(failure, "failure", error, []);
	assert.ok(!("cleanupFailureCommand" in failure));
});

test("package-exit diagnostics preserve only allowlisted phases without exposing helper output", () => {
	const evidence = {};
	for (const phase of [
		"helper-start",
		"start",
		"import-enter",
		"import-return",
		"query",
		"query-return",
		"present",
		"absent",
		"output-invalid",
	]) {
		const error = Object.assign(new Error("command=private"), { packageExitPhase: phase, stdout: "private-output" });
		recordGuiFailure(evidence, "failure", error, []);
		assert.equal(evidence.failurePackageExitPhase, phase);
		recordGuiFailure(evidence, "cleanupFailure", new AggregateError([error], "Observation failed"), []);
		assert.equal(evidence.cleanupFailureCauses[0].packageExitPhase, phase);
		assert.ok(!JSON.stringify(evidence).includes("private"));
	}
	recordGuiFailure(
		evidence,
		"failure",
		Object.assign(new Error("Unknown observation"), { packageExitPhase: "private" }),
		[],
	);
	assert.ok(!("failurePackageExitPhase" in evidence));
	const accessor = new Error("Unknown observation");
	Object.defineProperty(accessor, "packageExitPhase", { get: () => assert.fail("phase getter must not run") });
	recordGuiFailure(evidence, "failure", accessor, []);
	assert.ok(!("failurePackageExitPhase" in evidence));
});

test("native log reads only fixed owned files, bounds output and redacts sensitive lines", async () => {
	const root = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "hipi-native-log-")));
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

test("native log rejects noncanonical spellings and linked directories without exposing their paths", async () => {
	const root = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "hipi-native-log-private-")));
	try {
		const alias = join(root, "linked-directory");
		await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		for (const directory of [`${root}${sep}.`, alias]) {
			await assert.rejects(readNativeLog(directory, 0, []), {
				message: "Native log directory must be exactly canonical",
			});
		}
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
