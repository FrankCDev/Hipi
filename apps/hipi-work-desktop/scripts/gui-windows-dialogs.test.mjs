import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureWindowsIdentity, readWindowsDialogs } from "./gui-windows-dialogs.mjs";

const input = { pid: 123, binary: "C:\\owned\\Hipi Work.exe", spawnedAt: 123456 };
const confirmed = { status: "confirmed", pid: 123, startTicks: "123456789", session: 1 };

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
	async () => {
		const binary = join(
			process.env.SystemRoot ?? process.env.SYSTEMROOT,
			"System32/WindowsPowerShell/v1.0/powershell.exe",
		);
		const spawnedAt = Date.now();
		const child = spawn(
			binary,
			[
				"-NoProfile",
				"-NonInteractive",
				"-File",
				fileURLToPath(new URL("./gui-windows-dialog-fixture.ps1", import.meta.url)),
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const completion = once(child, "exit");
		const childReady = once(child.stdout, "data");
		const decoy = spawn(
			binary,
			[
				"-NoProfile",
				"-NonInteractive",
				"-File",
				fileURLToPath(new URL("./gui-windows-dialog-fixture.ps1", import.meta.url)),
			],
			{
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, HIPI_DIALOG_DECOY: "1" },
			},
		);
		const decoyCompletion = once(decoy, "exit");
		const ready = Promise.race([
			Promise.all([childReady, once(decoy.stdout, "data")]).then((results) => {
				for (const [data] of results) assert.equal(data.toString().trim(), "HIPI_FIXTURE_READY");
			}),
			Promise.race([completion, decoyCompletion]).then(() => {
				throw new Error("Fixture exited before readiness");
			}),
		]);
		void ready.catch(() => {});
		try {
			const identity = await captureWindowsIdentity({ pid: child.pid, binary, spawnedAt });
			assert.equal(identity.status, "confirmed");
			await ready;
			assert.equal((await readWindowsDialogs({ ...identity, startTicks: "1" })).status, "unknown");
			const result = await readWindowsDialogs(identity);
			assert.equal(result.status, "observed");
			assert.ok(result.codes.includes("ERR_MODULE_NOT_FOUND"));
			assert.ok(!result.codes.includes("ReferenceError"), "The separate decoy process must not be read");
			assert.ok(!JSON.stringify(result).includes("private-fixture-secret"));
		} finally {
			await Promise.all([completion, decoyCompletion]);
		}
	},
);
