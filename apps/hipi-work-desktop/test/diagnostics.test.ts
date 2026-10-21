import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { diagnosticMessages } from "../src/diagnostics/messages.ts";
import {
	diagnoseRuntimeOperation,
	RUNTIME_DIAGNOSTICS,
	runtimeDiagnostic,
	runtimeDiagnosticReporter,
} from "../src/diagnostics/runtime.ts";
import {
	DesktopDiagnostics,
	DIAGNOSTIC_LIMITS,
	DiagnosticExporter,
	finishFailedStartup,
	writeDiagnosticFile,
} from "../src/diagnostics/service.ts";
import { decode, encode } from "../src/ipc/protocol.ts";
import { createRuntimeRouter } from "../src/runtime/router.ts";
import { RuntimeSupervisor } from "../src/runtime/supervisor.ts";

const metadata = {
	productVersion: "0.0.1",
	electronVersion: "42.11.15",
	nodeVersion: "24.19.0",
	platform: "linux",
	arch: "x64",
};
const secret = "SECRET_SENTINEL_credential_path_url_prompt";

test("allowlist constructs bounded output without retaining unknown codes, extra fields or secrets", () => {
	const diagnostics = new DesktopDiagnostics();
	for (let index = 0; index < 20000; index++) {
		diagnostics.record("RUNTIME_UNAVAILABLE");
		diagnostics.record(`${secret}${index}`);
	}
	const injected = { ...metadata, message: secret, stack: secret, env: { secret }, toJSON: () => secret };
	const raw = diagnostics.serialize(injected, "ready");
	assert.equal(raw.includes(secret), false);
	assert.ok(Buffer.byteLength(raw) < DIAGNOSTIC_LIMITS.bytes);
	const parsed = JSON.parse(raw);
	assert.deepEqual(parsed.events[0], { code: "RUNTIME_UNAVAILABLE", count: DIAGNOSTIC_LIMITS.count });
	assert.equal(parsed.events.length, 6);
	const malformed = diagnostics.serialize(
		{ productVersion: secret, electronVersion: secret, nodeVersion: secret, platform: secret, arch: secret },
		secret,
	);
	assert.equal(malformed.includes(secret), false);
	assert.equal(JSON.parse(malformed).runtimeState, "unknown");
});

test("diagnostic status reads never fork, connect, or resume a runtime", () => {
	let starts = 0;
	const supervisor = new RuntimeSupervisor(
		() => {
			starts++;
			throw new Error("must not start");
		},
		() => {},
	);
	for (let index = 0; index < 100; index++) assert.equal(supervisor.diagnosticState(), "idle");
	assert.equal(starts, 0);
});

test("preview must approve the exact saved snapshot before the picker or write runs", async () => {
	const exporter = new DiagnosticExporter();
	const trace: string[] = [];
	const content = new DesktopDiagnostics().serialize(metadata, "ready");
	assert.equal(
		await exporter.export({
			snapshot: () => content,
			preview: async (raw) => {
				assert.equal(raw, content);
				trace.push("preview");
				return true;
			},
			pick: async () => {
				trace.push("pick");
				return "/chosen";
			},
			write: async (path, raw) => {
				assert.equal(path, "/chosen");
				assert.equal(raw, content);
				trace.push("write");
			},
		}),
		"saved",
	);
	assert.deepEqual(trace, ["preview", "pick", "write"]);
});

test("cancellation, preparation failure and size limit cannot write", async () => {
	for (const scenario of ["preview-cancel", "picker-cancel", "preview-fail", "picker-fail", "oversize"] as const) {
		let writes = 0;
		const result = await new DiagnosticExporter().export({
			snapshot: () => (scenario === "oversize" ? "x".repeat(DIAGNOSTIC_LIMITS.bytes + 1) : "{}"),
			preview: async () => {
				if (scenario === "preview-fail") throw new Error(secret);
				return scenario !== "preview-cancel";
			},
			pick: async () => {
				if (scenario === "picker-fail") throw new Error(secret);
				return scenario === "picker-cancel" ? null : "/chosen";
			},
			write: async () => {
				writes++;
			},
		});
		assert.equal(result, scenario.endsWith("cancel") ? "cancelled" : "failed");
		assert.equal(writes, 0);
	}
});

test("concurrent admission is bounded and closing during picker prevents writing", async () => {
	const exporter = new DiagnosticExporter();
	let finish: (value: string | null) => void = () => {};
	const picked = new Promise<string | null>((resolve) => {
		finish = resolve;
	});
	let writes = 0;
	const ports = {
		snapshot: () => "{}",
		preview: async () => true,
		pick: () => picked,
		write: async () => {
			writes++;
		},
	};
	const pending = exporter.export(ports);
	await Promise.resolve();
	for (let index = 0; index < 100; index++) assert.equal(await exporter.export(ports), "busy");
	exporter.close();
	finish("/chosen");
	assert.equal(await pending, "closed");
	assert.equal(await exporter.export(ports), "closed");
	assert.equal(writes, 0);
});

test("failed writes remain unknown and are never automatically replayed", async () => {
	let writes = 0;
	const result = await new DiagnosticExporter().export({
		snapshot: () => "{}",
		preview: async () => true,
		pick: async () => "/chosen",
		write: async () => {
			writes++;
			throw new Error(secret);
		},
	});
	assert.equal(result, "write-unknown");
	assert.equal(writes, 1);
});

test("pending writes retain admission; closure does not claim cancellation of an accepted write", async () => {
	let finish: () => void = () => {};
	const written = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const exporter = new DiagnosticExporter();
	const ports = { snapshot: () => "{}", preview: async () => true, pick: async () => "/chosen", write: () => written };
	const pending = exporter.export(ports);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await exporter.export(ports), "busy");
	exporter.close();
	finish();
	assert.equal(await pending, "saved");
});

test("real writer creates only a new file and refuses existing files and symlinks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-diagnostics-"));
	try {
		const path = join(dir, "diagnostics.json");
		await writeDiagnosticFile(path, "{}\n");
		assert.equal(await readFile(path, "utf8"), "{}\n");
		await assert.rejects(writeDiagnosticFile(path, "changed"));
		assert.equal(await readFile(path, "utf8"), "{}\n");
		const target = join(dir, "target.json");
		await writeFile(target, "private");
		// Windows symlink creation needs a separately authorized native privilege/Developer Mode fixture.
		if (process.platform !== "win32") {
			await symlink(target, join(dir, "link.json"));
			await assert.rejects(writeDiagnosticFile(join(dir, "link.json"), "changed"));
		}
		assert.equal(await readFile(target, "utf8"), "private");
		await assert.rejects(writeDiagnosticFile(join(dir, "large.json"), "x".repeat(DIAGNOSTIC_LIMITS.bytes + 1)));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("native diagnostic copy has complete Chinese and English keys", () => {
	const english = diagnosticMessages("en-US");
	assert.deepEqual(Object.keys(diagnosticMessages("zh-CN")), Object.keys(english));
	assert.equal(diagnosticMessages("de-DE"), english);
	assert.notEqual(diagnosticMessages("zh_CN")["diagnostics.menu"], english["diagnostics.menu"]);
});

test("write timeout reports uncertainty but retains admission until I/O settles without replay", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const exporter = new DiagnosticExporter();
	let finish: () => void = () => {};
	let writes = 0;
	const pendingWrite = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const ports = {
		snapshot: () => "{}",
		preview: async () => true,
		pick: async () => "/chosen",
		write: () => {
			writes++;
			return pendingWrite;
		},
	};
	const result = exporter.export(ports);
	await new Promise((resolve) => setImmediate(resolve));
	context.mock.timers.tick(DIAGNOSTIC_LIMITS.writeWaitMs);
	assert.equal(await result, "write-unknown");
	assert.equal(await exporter.export(ports), "busy");
	assert.equal(writes, 1);
	finish();
	await pendingWrite;
	assert.equal(writes, 1);
});

test("known bounded prerelease versions survive while arbitrary suffixes remain excluded", () => {
	const diagnostics = new DesktopDiagnostics();
	for (const productVersion of [
		"1.0.0-rc.1",
		"1.0.0-alpha.12",
		"1.0.0-beta.999999",
		"999999.999999.999999-beta.999999",
	]) {
		const result = JSON.parse(diagnostics.serialize({ ...metadata, productVersion }, "ready"));
		assert.equal(result.productVersion, productVersion);
	}
	for (const productVersion of [
		"1.0.0-rc.1000000",
		"999999.999999.999999-alpha.999999",
		"1000000.0.0",
		"1.0.0-preview.1",
		`1.0.0-${secret}`,
		`1.0.0-rc.1+${secret}`,
		"1.0.0-rc.1\n",
		"1.0.0-rc.1.extra",
	]) {
		const raw = diagnostics.serialize({ ...metadata, productVersion }, "ready");
		assert.equal(JSON.parse(raw).productVersion, "unknown");
		assert.equal(raw.includes(secret), false);
	}
});

test("actual storage-open failure is sanitized through startup capture and host export", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-diagnostic-storage-"));
	const messages: string[] = [];
	const report = runtimeDiagnosticReporter("generation", (raw) => messages.push(raw));
	try {
		const blocked = join(dir, secret);
		await writeFile(blocked, secret);
		await assert.rejects(
			diagnoseRuntimeOperation(
				() => openTestRuntime(blocked, { resume: false, onDiagnostic: report }),
				{ category: "startup", phase: "runtime-open" },
				report,
			),
		);
		const diagnostics = new DesktopDiagnostics();
		for (const raw of messages) {
			assert.equal(raw.includes(secret), false);
			diagnostics.recordRuntime(runtimeDiagnostic(decode(raw)));
		}
		assert.deepEqual(
			messages.map((raw) => runtimeDiagnostic(decode(raw))),
			[
				{ category: "storage", phase: "storage-open" },
				{ category: "startup", phase: "runtime-open" },
			],
		);
		const content = diagnostics.serialize(metadata, "failed");
		assert.equal(content.includes(secret), false);
		assert.ok(Buffer.byteLength(content) <= DIAGNOSTIC_LIMITS.bytes);
		assert.equal(JSON.parse(content).runtimeEvents.filter((item: { count: number }) => item.count === 1).length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("close classification comes from router shutdown and preserves original failure and ownership", async () => {
	const messages: string[] = [];
	const failure = new Error(secret);
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async () => {
				throw new Error("unused");
			},
			close: async () => {
				throw failure;
			},
		},
		"generation",
		(raw) => messages.push(raw),
		async () => {},
		runtimeDiagnosticReporter("generation", (raw) => messages.push(raw)),
	);
	await assert.rejects(router.shutdown(), (error) => error === failure);
	await assert.rejects(router.shutdown(), (error) => error === failure);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].includes(secret), false);
	assert.deepEqual(runtimeDiagnostic(decode(messages[0])), { category: "close", phase: "runtime-close" });
});

class DiagnosticChild extends EventEmitter {
	generation: string;
	constructor(generation: string) {
		super();
		this.generation = generation;
	}
	postMessage() {}
	kill() {
		return true;
	}
	message(value: object) {
		this.emit("message", encode({ generation: this.generation, ...value }));
	}
}

test("supervisor accepts only exact versioned current-generation diagnostic frames before failure or exit", async () => {
	const children: DiagnosticChild[] = [];
	const diagnostics = new DesktopDiagnostics();
	const supervisor = new RuntimeSupervisor(
		(generation) => {
			const child = new DiagnosticChild(generation);
			children.push(child);
			return child;
		},
		() => {},
		undefined,
		(value) => diagnostics.recordRuntime(value),
	);
	const started = supervisor.start();
	children[0].message({ kind: "ready" });
	await started;
	const valid = { version: 1, kind: "diagnostic", category: "operation", phase: "unknown" };
	children[0].message({ ...valid, generation: "stale" });
	children[0].message(valid);
	children[0].emit("exit", 1);
	children[0].message(valid);
	children[1].message({ kind: "ready" });
	children[1].message({ ...valid, version: 2, stack: secret });
	children[1].message(valid);
	const content = diagnostics.serialize(metadata, supervisor.diagnosticState());
	assert.equal(content.includes(secret), false);
	assert.equal(JSON.parse(content).runtimeEvents.find((item: { phase: string }) => item.phase === "unknown").count, 1);
	const closing = supervisor.close();
	children[1].emit("exit", 1);
	await closing;
	children[1].message(valid);
	assert.equal(diagnostics.serialize(metadata, "failed"), content);
});

test("runtime diagnostic protocol rejects invalid combinations, extra payload and unsupported versions", () => {
	const valid = { version: 1, generation: "current", kind: "diagnostic", category: "startup", phase: "runtime-open" };
	for (const invalid of [
		{ ...valid, version: 2 },
		{ ...valid, phase: "storage-open" },
		{ ...valid, error: new Error(secret) },
		{ ...valid, stack: secret },
		{ ...valid, phase: secret },
		{ ...valid, generation: "bad generation" },
	])
		assert.throws(() => runtimeDiagnostic(invalid));
	const output: string[] = [];
	runtimeDiagnosticReporter("current", (raw) => output.push(raw))({
		category: "operation",
		phase: "unknown",
		...{ error: secret },
	});
	assert.equal(output[0].includes(secret), false);
});

test("startup recovery reviews exports before exit and never treats cancellation or unknown writes as clean shutdown", async () => {
	for (const scenario of ["saved", "cancelled", "write-unknown", "dialog-failed"] as const) {
		let exited = false;
		let release: (value: boolean) => void = () => {};
		const stopped = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		let outcome: string | undefined;
		const exporter = new DiagnosticExporter();
		const pending = finishFailedStartup({
			stop: () => stopped,
			review: async () => {
				if (scenario === "dialog-failed") throw new Error(secret);
				outcome = await exporter.export({
					snapshot: () => new DesktopDiagnostics().serialize(metadata, "failed"),
					preview: async () => scenario !== "cancelled",
					pick: async () => "/chosen",
					write: async () => {
						if (scenario === "write-unknown") throw new Error(secret);
					},
				});
			},
			exit: () => {
				exporter.close();
				exited = true;
			},
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(exited, false);
		assert.equal(outcome, scenario === "dialog-failed" ? undefined : scenario);
		release(false);
		await pending;
		assert.equal(exited, true);
	}
});

test("unconfirmed shutdown failure prevents startup recovery from exiting", async () => {
	let exited = false;
	await assert.rejects(
		finishFailedStartup({
			stop: async () => {
				throw new Error(secret);
			},
			review: async () => {},
			exit: () => {
				exited = true;
			},
		}),
		/RUNTIME_EXIT_UNCONFIRMED/,
	);
	assert.equal(exited, false);
});

test("failed startup keeps native export available while supervisor waits for actual utility exit", async () => {
	const children: DiagnosticChild[] = [];
	const diagnostics = new DesktopDiagnostics();
	const supervisor = new RuntimeSupervisor(
		(generation) => {
			const child = new DiagnosticChild(generation);
			children.push(child);
			return child;
		},
		() => {},
		undefined,
		(value) => diagnostics.recordRuntime(value),
	);
	const started = supervisor.start();
	const report = runtimeDiagnosticReporter(children[0].generation, (raw) => children[0].emit("message", raw));
	report({ category: "startup", phase: "runtime-open" });
	children[0].message({ kind: "fatal" });
	await assert.rejects(started, { code: "CLOSED" });
	let exited = false;
	let saved = "";
	const exporter = new DiagnosticExporter();
	const recovery = finishFailedStartup({
		stop: () => supervisor.close(),
		review: async () => {
			assert.equal(
				await exporter.export({
					snapshot: () => diagnostics.serialize(metadata, supervisor.diagnosticState()),
					preview: async (raw) => {
						assert.equal(raw.includes(secret), false);
						assert.equal(JSON.parse(raw).runtimeEvents[0].count, 1);
						return true;
					},
					pick: async () => "/chosen",
					write: async (_path, raw) => {
						saved = raw;
					},
				}),
				"saved",
			);
		},
		exit: () => {
			exited = true;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.notEqual(saved, "");
	assert.equal(exited, false);
	children[0].emit("exit", 1);
	await recovery;
	assert.equal(exited, true);
	assert.equal(children.length, 1);
});

test("failure diagnostics cannot replace an original exception even when the observer throws", async () => {
	const failure = new Error(secret);
	await assert.rejects(
		diagnoseRuntimeOperation(
			async () => {
				throw failure;
			},
			{ category: "startup", phase: "file-services-open" },
			() => {
				throw new Error("observer");
			},
		),
		(error) => error === failure,
	);
});

test("all runtime counters saturate within the original four KiB export limit", () => {
	const diagnostics = new DesktopDiagnostics();
	for (let index = 0; index < 20000; index++) {
		for (const value of RUNTIME_DIAGNOSTICS) diagnostics.recordRuntime(value);
	}
	const raw = diagnostics.serialize(metadata, "failed");
	assert.ok(Buffer.byteLength(raw) <= DIAGNOSTIC_LIMITS.bytes);
	assert.ok(JSON.parse(raw).runtimeEvents.every((item: { count: number }) => item.count === DIAGNOSTIC_LIMITS.count));
});

test("file service shutdown failure is not mislabeled as runtime close and does not release runtime", async () => {
	const messages: string[] = [];
	let runtimeClosed = false;
	const failure = new Error(secret);
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async () => {
				throw new Error("unused");
			},
			close: async () => {
				runtimeClosed = true;
			},
		},
		"generation",
		() => {},
		async () => {
			throw failure;
		},
		runtimeDiagnosticReporter("generation", (raw) => messages.push(raw)),
	);
	await assert.rejects(router.shutdown(), (error) => error === failure);
	assert.equal(runtimeClosed, false);
	assert.deepEqual(
		messages.map((raw) => runtimeDiagnostic(decode(raw))),
		[{ category: "close", phase: "file-services-close" }],
	);
});

test("subscription disposal failure is attributed to subscription close before runtime close", async () => {
	const messages: string[] = [];
	let runtimeClosed = false;
	const failure = new Error(secret);
	const router = createRuntimeRouter(
		{
			execute: async () => null,
			observe: async () => ({
				dispose: async () => {
					throw failure;
				},
			}),
			close: async () => {
				runtimeClosed = true;
			},
		},
		"generation",
		() => {},
		async () => {},
		runtimeDiagnosticReporter("generation", (raw) => messages.push(raw)),
	);
	const observation = router.receive(
		encode({
			generation: "generation",
			id: "observe",
			kind: "observe",
			input: { scope: { workspaceId: "workspace", conversationId: "conversation" }, expectedStoreId: "store" },
		}),
	);
	const rejected = assert.rejects(observation, (error) => error === failure);
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(router.shutdown(), (error) => error === failure);
	await rejected;
	assert.equal(runtimeClosed, false);
	assert.deepEqual(
		messages.map((raw) => runtimeDiagnostic(decode(raw))),
		[{ category: "close", phase: "subscriptions-close" }],
	);
});
