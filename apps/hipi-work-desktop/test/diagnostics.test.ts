import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosticMessages } from "../src/diagnostic-messages.ts";
import { DesktopDiagnostics, DIAGNOSTIC_LIMITS, DiagnosticExporter, writeDiagnosticFile } from "../src/diagnostics.ts";
import { RuntimeSupervisor } from "../src/supervisor.ts";

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
	assert.equal(parsed.events.length, 5);
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
