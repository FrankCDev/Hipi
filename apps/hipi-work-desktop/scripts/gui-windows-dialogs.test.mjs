import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureWindowsIdentity, readWindowsDialogs } from "./gui-windows-dialogs.mjs";

const input = { pid: 123, binary: "C:\\owned\\Hipi Work.exe", spawnedAt: 123456 };
const confirmed = { status: "confirmed", pid: 123, startTicks: "123456789", session: 1 };

// Fixture output is a fixed ASCII protocol, not an error-log transport.
function fixtureReadiness(stdout, completion) {
	const phases = new Set([
		"forms-load",
		"native-compile",
		"timers-start",
		"activation-create",
		"activation-activate",
		"task-dialog-call",
		"classic-dialog-call",
	]);
	const failures = new Set([
		"ERROR_FILE_NOT_FOUND",
		"ERROR_PATH_NOT_FOUND",
		"ERROR_ACCESS_DENIED",
		"ERROR_INVALID_PARAMETER",
		"ERROR_SXS_CANT_GEN_ACTCTX",
		"ACTIVATION_NATIVE_FAILURE",
		"E_INVALIDARG",
		"E_OUTOFMEMORY",
		"E_FAIL",
		"TASK_DIALOG_FAILED",
		"ENTRY_POINT_NOT_FOUND",
		"DLL_NOT_FOUND",
		"FIXTURE_EXCEPTION",
	]);
	return new Promise((resolve, reject) => {
		let lastPhase = "fixture-start";
		let bytes = 0;
		let pending = "";
		let settled = false;
		function finish(code) {
			if (settled) return;
			settled = true;
			stdout.off("data", receive);
			stdout.resume();
			if (code) reject(new Error(`Fixture readiness failed: ${code}; phase=${lastPhase}`));
			else resolve();
		}
		function receive(chunk) {
			bytes += chunk.length;
			if (bytes > 4096) return finish("OUTPUT_LIMIT");
			pending += chunk.toString("utf8");
			while (!settled) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				if (line.length > 128) return finish("OUTPUT_LIMIT");
				if (line === "HIPI_FIXTURE_READY")
					return finish(lastPhase.endsWith("-dialog-call") ? undefined : "UNEXPECTED_READY");
				const phase = line.slice("HIPI_FIXTURE_PHASE:".length);
				const failure = line.slice("HIPI_FIXTURE_FAILURE:".length);
				if (line.startsWith("HIPI_FIXTURE_PHASE:") && phases.has(phase)) lastPhase = phase;
				else if (line.startsWith("HIPI_FIXTURE_FAILURE:") && failures.has(failure)) return finish(failure);
				else return finish("INVALID_OUTPUT");
			}
			if (pending.length > 128) finish("OUTPUT_LIMIT");
		}
		stdout.on("data", receive);
		void completion.then(
			(result) =>
				finish(
					result?.[0] === 0xc0000005 || result?.[0] === -1073741819 ? "NATIVE_ACCESS_VIOLATION" : "EXIT_BEFORE_READY",
				),
			() => finish("PROCESS_ERROR"),
		);
	});
}

test("fixture readiness accepts split fixed phases and reports bounded failure codes without raw output", async () => {
	const stdout = new PassThrough();
	const ready = fixtureReadiness(stdout, Promise.resolve());
	stdout.write("HIPI_FIXTURE_PHASE:forms-load\nHIPI_FIXTURE_PHASE:task-dia");
	stdout.write("log-call\r\nHIPI_FIXTURE_RE");
	stdout.write("ADY\n");
	await ready;
	assert.equal(stdout.listenerCount("data"), 0);
	for (const [output, code, phase] of [
		["HIPI_FIXTURE_PHASE:activation-create\n", "EXIT_BEFORE_READY", "activation-create"],
		["HIPI_FIXTURE_PHASE:task-dialog-call\nHIPI_FIXTURE_FAILURE:E_INVALIDARG\n", "E_INVALIDARG", "task-dialog-call"],
		["HIPI_FIXTURE_PHASE:private-path\n", "INVALID_OUTPUT", "fixture-start"],
		["HIPI_FIXTURE_FAILURE:private-secret\n", "INVALID_OUTPUT", "fixture-start"],
		["private exception and path\n", "INVALID_OUTPUT", "fixture-start"],
		["HIPI_FIXTURE_READY\n", "UNEXPECTED_READY", "fixture-start"],
		["x".repeat(129), "OUTPUT_LIMIT", "fixture-start"],
		["HIPI_FIXTURE_PHASE:forms-load\n".repeat(200), "OUTPUT_LIMIT", "fixture-start"],
	]) {
		const stream = new PassThrough();
		const result = fixtureReadiness(stream, Promise.resolve());
		stream.write(output);
		await assert.rejects(result, { message: `Fixture readiness failed: ${code}; phase=${phase}` });
		assert.equal(stream.listenerCount("data"), 0);
	}
	await assert.rejects(fixtureReadiness(new PassThrough(), Promise.reject(new Error("private spawn path"))), {
		message: "Fixture readiness failed: PROCESS_ERROR; phase=fixture-start",
	});
	await assert.rejects(fixtureReadiness(new PassThrough(), Promise.resolve([0xc0000005, null])), {
		message: "Fixture readiness failed: NATIVE_ACCESS_VIOLATION; phase=fixture-start",
	});
});

test("task fixture preserves HRESULT diagnostics and uses the SDK's zero-extended error-icon resource", async () => {
	const script = await readFile(new URL("./gui-windows-dialog-fixture.ps1", import.meta.url), "utf8");
	assert.match(script, /static extern int TaskDialog\(/);
	assert.match(script, /new IntPtr\(0xFFFE\)/);
	assert.doesNotMatch(script, /new IntPtr\(-2\)|PreserveSig=false/);
	assert.match(script, /result == unchecked\(\(int\)0x80070057\)/);
	assert.match(script, /Phase\("activation-create"\)/);
	assert.match(script, /Phase\("task-dialog-call"\)/);
	const manifest = await readFile(new URL("./gui-windows-dialog-fixture.manifest", import.meta.url), "utf8");
	assert.match(manifest, /<assembly[^>]*>\s*<assemblyIdentity type="win32" name="Hipi.Work.DialogFixture"/);
	const failure = script.slice(script.lastIndexOf("\n} catch {"));
	assert.match(failure, /\$code = 'FIXTURE_EXCEPTION'/);
	assert.match(failure, /\$depth -lt 4/);
	assert.doesNotMatch(failure, /\.Message|\.ToString\(|Write-Error/);
});

test("identity failures preserve only fixed diagnostic phases without weakening unknown", async () => {
	for (const reason of [
		"utility-import",
		"process-image",
		"spawn-window",
		"session-mismatch",
		"image-mismatch",
		"native-compile",
	]) {
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
	assert.deepEqual(timedOut, { status: "unknown", reason: "helper-timeout", lastPhase: "helper-start" });
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

test("bounded JSONL progress survives timeout without leaking output or proving identity", async () => {
	for (const [stdout, lastPhase] of [
		['{"phase":"utility-import"}\n', "utility-import"],
		['{"phase":"request"}\n{"phase":"process-image"}\n', "process-image"],
		['{"phase":"process-handle"}\n{"phase":"private-path"}\nsecret\n{"phase":"process-image"}', "process-handle"],
		['{"phase":"process-image","secret":"private"}\n', "helper-start"],
		["x".repeat(17000), "helper-start"],
	]) {
		const identity = await captureWindowsIdentity(input, {
			platform: "win32",
			run: async () => {
				throw Object.assign(Error("secret"), { killed: true, stdout });
			},
		});
		assert.deepEqual(identity, { status: "unknown", reason: "helper-timeout", lastPhase });
		assert.deepEqual(
			await readWindowsDialogs(identity, {
				platform: "win32",
				run: () => {
					throw Error("must not retry");
				},
			}),
			identity,
		);
	}
	const identity = await captureWindowsIdentity(input, {
		platform: "win32",
		run: async () => ({ stdout: `{"phase":"request"}\n{"phase":"spawn-window"}\n${JSON.stringify(confirmed)}\n` }),
	});
	assert.deepEqual(identity, { ...confirmed, binary: input.binary });
	for (const stdout of ['{"phase":"spawn-window"}\n', `{"phase":"private"}\n${JSON.stringify(confirmed)}`]) {
		assert.equal(
			(await captureWindowsIdentity(input, { platform: "win32", run: async () => ({ stdout }) })).status,
			"unknown",
		);
	}
});

test("helper loads only its installed Utility module before parsing and can report an import failure", async () => {
	const script = await readFile(new URL("./gui-windows-dialogs.ps1", import.meta.url), "utf8");
	const explicitImport =
		"Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop";
	assert.match(script, /\$PSModuleAutoLoadingPreference = 'None'/);
	assert.ok(script.indexOf("$PSModuleAutoLoadingPreference = 'None'") < script.indexOf(explicitImport));
	assert.ok(script.indexOf(explicitImport) > 0);
	assert.ok(script.indexOf(explicitImport) < script.indexOf("| ConvertFrom-Json"));
	const failure = script.slice(script.lastIndexOf("\n} catch {"), script.lastIndexOf("\n} finally {"));
	assert.match(failure, /\[Console\]::Out\.WriteLine\('\{"status":"unknown","reason":"' \+ \$script:phase \+ '"\}'\)/);
	assert.doesNotMatch(failure, /\|\s*ConvertTo-Json/);
});

test("task-dialog accessibility stays under an owned HWND with bounded, read-only text classification", async () => {
	const script = await readFile(new URL("./gui-windows-dialogs.ps1", import.meta.url), "utf8");
	assert.match(script, /AutomationElement\.FromHandle\(hwnd\)/);
	assert.match(script, /element\.Current\.ProcessId != pid/);
	assert.match(script, /native == 0 \|\| Owned\(new IntPtr\(native\), pid\)/);
	assert.match(script, /controls >= 16 \|\| depth > 4/);
	assert.match(script, /clock\.ElapsedMilliseconds >= 2000/);
	assert.match(script, /value = value\.Substring\(0, 2047\)/);
	assert.match(script, /var controlType = element\.Current\.ControlType/);
	assert.match(script, /controlType == ControlType\.Text/);
	assert.doesNotMatch(
		script,
		/AutomationElement\.RootElement|FindAll\(|FindFirst\(|SetFocus\(|InvokePattern|SendKeys|PostMessage/,
	);
	for (const forbidden of ["IDENTITY_CHANGED", "ENUMERATION_UNAVAILABLE"]) {
		const result = await readWindowsDialogs(confirmed, {
			platform: "win32",
			run: async () => ({
				stdout: JSON.stringify({
					status: "observed",
					codes: ["TASK_DIALOG_TEXT_OBSERVED", "ERR_MODULE_NOT_FOUND", forbidden],
					raw: "private-dialog-text",
				}),
			}),
		});
		assert.deepEqual(result, { status: "unknown", reason: "owned-window-query-unavailable" });
	}
	assert.deepEqual(
		await readWindowsDialogs(confirmed, {
			platform: "win32",
			run: async () => ({
				stdout: JSON.stringify({
					status: "observed",
					codes: ["TASK_DIALOG_TEXT_OBSERVED"],
					raw: "private-dialog-text",
				}),
			}),
		}),
		{ status: "observed", codes: ["TASK_DIALOG_TEXT_OBSERVED"] },
	);
	const diagnostics = [
		"DIRECTUI_CONTROL_OBSERVED",
		"SYSLINK_CONTROL_OBSERVED",
		"STATIC_CONTROL_OBSERVED",
		"UIA_ROOT_OBSERVED",
		"UIA_TEXT_EMPTY",
		"UIA_PANE_OBSERVED",
		"UIA_HYPERLINK_OBSERVED",
		"UIA_CUSTOM_OBSERVED",
		"UIA_BUTTON_OBSERVED",
		"UIA_WINDOW_OBSERVED",
		"UIA_OTHER_OBSERVED",
		"UIA_TIME_LIMIT",
		"UIA_CONTROL_LIMIT",
		"UIA_DEPTH_LIMIT",
		"NATIVE_TIME_LIMIT",
		"NATIVE_CONTROL_LIMIT",
		"NATIVE_WINDOW_LIMIT",
	];
	assert.deepEqual(
		await readWindowsDialogs(confirmed, {
			platform: "win32",
			run: async () => ({ stdout: JSON.stringify({ status: "observed", codes: diagnostics, text: "private" }) }),
		}),
		{ status: "observed", codes: [...diagnostics].sort() },
	);
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
	assert.ok(
		Object.keys(calls[0].options.env).every((key) =>
			/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HIPI_WINDOW_REQUEST)$/i.test(key),
		),
		"The helper must not inherit profile, module-discovery or unrelated private environment values",
	);
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
	"Windows helper parses requests without profile or module search environment",
	{ skip: process.platform !== "win32", timeout: 15000 },
	async (context) => {
		const binary = join(
			process.env.SystemRoot ?? process.env.SYSTEMROOT,
			"System32/WindowsPowerShell/v1.0/powershell.exe",
		);
		const execute = promisify(execFile);
		let phases;
		const identity = await captureWindowsIdentity(input, {
			run: async (_command, args, options) => {
				const started = performance.now();
				const timings = [];
				let bytes = 0;
				let pending = "";
				const execution = execute(binary, args, {
					...options,
					env: { ...options.env, HIPI_WINDOW_REQUEST: "{invalid-private-request" },
				});
				function record(chunk) {
					bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
					if (bytes > 4096 || timings.length >= 8) return;
					pending += chunk.toString("utf8");
					const lines = pending.split(/\r?\n/);
					pending = lines.pop();
					for (const rawLine of lines) {
						if (timings.length >= 8) break;
						const line = rawLine.replace(/^\uFEFF/, "");
						// Exact constants only; no exception, request, path or other output is logged.
						const phase =
							line === '{"status":"unknown","reason":"request"}'
								? "request-rejected"
								: line === '{"phase":"utility-import"}' || line === '{"phase":"request"}'
									? JSON.parse(line).phase
									: undefined;
						if (phase)
							timings.push({
								phase,
								afterMs: Math.min(10000, Math.max(0, Math.round(performance.now() - started))),
							});
					}
				}
				execution.child.stdout.on("data", record);
				try {
					const result = await execution;
					phases = result.stdout
						.trim()
						.split(/\r?\n/)
						.map((line) => JSON.parse(line));
					return result;
				} finally {
					execution.child.stdout.off("data", record);
					context.diagnostic(JSON.stringify({ malformedRequestPhaseTimings: timings }));
				}
			},
		});
		assert.deepEqual(identity, { status: "unknown", reason: "request" });
		assert.deepEqual(phases, [
			{ phase: "utility-import" },
			{ phase: "request" },
			{ status: "unknown", reason: "request" },
		]);
	},
);

for (const kind of ["classic", "task"])
	test(
		`Windows native ${kind} dialog query verifies process identity and observes only fixed error codes`,
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
						env: { ...process.env, HIPI_DIALOG_DECOY: decoy ? "1" : "0", HIPI_DIALOG_KIND: kind },
					},
				);
				// close follows stdout drain, so an early native failure cannot race its final fixed code.
				const completion = once(child, "close");
				const ready = fixtureReadiness(child.stdout, completion);
				void ready.catch(() => {});
				return { child, spawnedAt, completion, ready };
			}
			const primary = fixture();
			let decoy;
			try {
				// The real modal loop must be ready before inspecting its process image.
				await primary.ready;
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
				// The boundary returns reviewed constants only, never raw window content.
				context.diagnostic(JSON.stringify({ ownedDialogObservation: result }));
				assert.equal(result.status, "observed", JSON.stringify(result));
				assert.equal(decoy.child.exitCode, null, "Decoy must not disappear before isolation is checked");
				assert.ok(result.codes.includes("ERR_MODULE_NOT_FOUND"), JSON.stringify(result));
				assert.ok(result.codes.includes("ELECTRON_MAIN_JS_ERROR"), JSON.stringify(result));
				if (kind === "task") assert.ok(result.codes.includes("TASK_DIALOG_TEXT_OBSERVED"), JSON.stringify(result));
				assert.ok(!result.codes.includes("ReferenceError"), "The separate decoy process must not be read");
				assert.ok(!JSON.stringify(result).includes("private-fixture-secret"));
			} finally {
				// Keep the sanitized readiness failure, not a raw OS spawn error from cleanup.
				await Promise.allSettled([primary.completion, decoy?.completion]);
			}
		},
	);
