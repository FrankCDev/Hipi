import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureWindowsIdentity, readWindowsDialogs } from "./gui-windows-dialogs.mjs";

const input = { pid: 123, binary: "C:\\owned\\Hipi Work.exe", spawnedAt: 123456 };
const confirmed = { status: "confirmed", pid: 123, startTicks: "123456789", session: 1 };

test("identity failures preserve only fixed diagnostic phases without weakening unknown", async () => {
	for (const reason of ["process-image", "spawn-window", "session-mismatch", "image-mismatch", "native-compile"]) {
		const identity = await captureWindowsIdentity(input, {
			platform: "win32",
			run: async () => ({ stdout: JSON.stringify({ status: "unknown", reason, path: "private" }) }),
		});
		assert.deepEqual(identity, { status: "unknown", reason });
		assert.deepEqual(
			await readWindowsDialogs(identity, {
				platform: "win32",
				run: () => {
					throw Error("must not query after denial");
				},
			}),
			identity,
		);
	}
	const forged = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => ({ stdout: JSON.stringify({ status: "unknown", reason: "secret path" }) }),
	});
	assert.deepEqual(forged, { status: "unknown", reason: "owned-window-query-unavailable" });
	const timedOut = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => {
			throw Object.assign(Error("private command"), { killed: true });
		},
	});
	assert.deepEqual(timedOut, { status: "unknown", reason: "helper-timeout" });
	const overflow = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => {
			throw Object.assign(Error("private command"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
		},
	});
	assert.deepEqual(overflow, { status: "unknown", reason: "helper-output" });
	const policyDenied = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => {
			throw Object.assign(Error("private"), { stderr: "private script path PSSecurityException" });
		},
	});
	assert.deepEqual(policyDenied, { status: "unknown", reason: "helper-policy-denied" });
});

test("owned-window query binds PID and fixed script, strips raw fields, and never falls back after refusal", async () => {
	const calls = [];
	const run = async (command, args, options) => {
		calls.push({ command, args, options });
		return { stdout: JSON.stringify({ ...confirmed, raw: "secret" }) };
	};
	const identity = await captureWindowsIdentity(input, { platform: "win32", run });
	assert.deepEqual(identity, { ...confirmed, binary: input.binary });
	assert.equal(calls[0].command, "powershell.exe");
	assert.ok(calls[0].args.includes("-File"));
	assert.ok(!calls[0].args.includes("-ExecutionPolicy"));
	assert.equal(JSON.parse(calls[0].options.env.HIPI_WINDOW_REQUEST).pid, 123);
	assert.equal(calls[0].options.maxBuffer, 16384);
	assert.equal(calls[0].options.timeout, 10000);
	const evidence = await readWindowsDialogs(identity, {
		platform: "win32",
		run: async () => ({
			stdout: JSON.stringify({ status: "observed", codes: ["ERR_MODULE_NOT_FOUND"], raw: "private data" }),
		}),
	});
	assert.deepEqual(evidence, { status: "observed", codes: ["ERR_MODULE_NOT_FOUND"] });
	for (const result of [null, { ...confirmed, pid: 456 }, { ...confirmed, startTicks: "private" }]) {
		assert.equal(
			(
				await captureWindowsIdentity(input, {
					platform: "win32",
					run: async () => ({ stdout: JSON.stringify(result) }),
				})
			).status,
			"unknown",
		);
	}
	let deniedCalls = 0;
	const denied = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => {
			deniedCalls++;
			throw new Error("denied private path");
		},
	});
	assert.equal(
		(
			await readWindowsDialogs(denied, {
				platform: "win32",
				run: async () => {
					deniedCalls++;
				},
			})
		).status,
		"unknown",
	);
	assert.equal(deniedCalls, 1);
});

test("untrusted output, excessive text, platform mismatch and unknown codes cannot become evidence", async () => {
	for (const stdout of [
		"not json secret",
		"x".repeat(17000),
		JSON.stringify({ status: "observed", codes: ["private text"] }),
	]) {
		assert.equal(
			(await readWindowsDialogs(confirmed, { platform: "win32", run: async () => ({ stdout }) })).status,
			"unknown",
		);
	}
	assert.deepEqual(
		await captureWindowsIdentity(input, {
			platform: "linux",
			run: () => {
				throw Error("must not run");
			},
		}),
		{ status: "not-applicable" },
	);
});

test(
	"Windows native query verifies process identity and observes only fixed error codes",
	{ skip: process.platform !== "win32", timeout: 35000 },
	async (context) => {
		const binary = join(
			process.env.SystemRoot ?? process.env.SYSTEMROOT,
			"System32/WindowsPowerShell/v1.0/powershell.exe",
		);
		context.diagnostic(
			JSON.stringify({
				testEnvironmentPresence: Object.fromEntries(
					["PSExecutionPolicyPreference", "PSModulePath", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map((key) => [
						key,
						Object.keys(process.env).some((name) => name.toLowerCase() === key.toLowerCase()),
					]),
				),
				queryEnvironmentPresence: {
					PSExecutionPolicyPreference: false,
					PSModulePath: false,
					USERPROFILE: false,
					APPDATA: false,
					LOCALAPPDATA: false,
				},
			}),
		);
		// Resolve the known installed Windows PowerShell binary, not a PATH alias.
		const execute = promisify(execFile);
		const run = (_command, args, options) => execute(binary, args, options);
		function fixture(decoy = false) {
			const spawnedAt = Date.now();
			const child = spawn(
				binary,
				[
					"-NoProfile",
					"-NonInteractive",
					"-File",
					fileURLToPath(new URL("./gui-windows-dialog-fixture.ps1", import.meta.url)),
				],
				{
					stdio: ["ignore", "pipe", "ignore"],
					env: { ...process.env, HIPI_DIALOG_DECOY: decoy ? "1" : "0" },
				},
			);
			const completion = once(child, "exit");
			const ready = Promise.race([
				once(child.stdout, "data").then(([data]) => assert.equal(data.toString().trim(), "HIPI_FIXTURE_READY")),
				completion.then(() => {
					throw new Error("Fixture exited before readiness");
				}),
			]);
			void ready.catch(() => {});
			return { child, spawnedAt, completion, ready };
		}
		const primary = fixture();
		let decoy;
		try {
			// Identity has no C# compilation. Do not cold-start the unrelated decoy
			// compiler until this earliest boundary is confirmed.
			const identity = await captureWindowsIdentity(
				{ pid: primary.child.pid, binary, spawnedAt: primary.spawnedAt },
				{ run },
			);
			assert.equal(identity.status, "confirmed", JSON.stringify(identity));
			decoy = fixture(true);
			await Promise.all([primary.ready, decoy.ready]);
			const mismatch = await readWindowsDialogs({ ...identity, startTicks: "1" }, { run });
			assert.equal(mismatch.status, "unknown");
			assert.equal(mismatch.reason, "capture-identity");
			assert.equal(primary.child.exitCode, null, "Primary fixture must remain alive during observation");
			assert.equal(decoy.child.exitCode, null, "Decoy must remain alive during observation");
			const result = await readWindowsDialogs(identity, { run });
			assert.equal(result.status, "observed", JSON.stringify(result));
			assert.equal(decoy.child.exitCode, null, "Decoy must not disappear before isolation is checked");
			assert.ok(result.codes.includes("ERR_MODULE_NOT_FOUND"));
			assert.ok(!result.codes.includes("ReferenceError"), "The separate decoy process must not be read");
			assert.ok(!JSON.stringify(result).includes("private-fixture-secret"));
		} finally {
			await Promise.all([primary.completion, decoy?.completion]);
		}
	},
);
