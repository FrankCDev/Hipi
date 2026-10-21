import assert from "node:assert/strict";
import type { ExecFileException } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AppearanceError, parseFontReply, parseInstalledFontCatalog } from "@hipi/work-runtime/appearance";
import { decodeFontRequest } from "../src/appearance/protocol.ts";
import { openTypeFontNames } from "../src/fonts/opentype-names.ts";
import { FontRequests } from "../src/fonts/requests.ts";
import { FONTCONFIG_FORMAT, MAC_FONT_SCRIPT, WINDOWS_FONT_SCRIPT } from "../src/fonts/scripts.ts";
import {
	type FontDiagnostic,
	fontCommand,
	NATIVE_FONT_LIMITS,
	NativeFontService,
	parseNativeFonts,
	runFontProcess,
} from "../src/fonts/service.ts";

const face = {
	family: "Example Mono",
	fullName: "Example Mono Bold",
	postscriptName: "ExampleMono-Bold",
	style: "Bold",
};
const linux = `${face.family}\x1f${face.fullName}\x1f${face.postscriptName}\x1f${face.style}\x1f100\x1e`;
const id = "12345678-1234-4123-8123-123456789abc";
const code = (expected: string) => (error: unknown) => error instanceof AppearanceError && error.code === expected;

/** Synthetic spec fixture, not evidence of native Windows execution. */
function nameTable(
	entries: [number, string][] = [
		[1, face.family],
		[2, face.style],
		[4, face.fullName],
		[6, face.postscriptName],
	],
) {
	const strings = entries.map(([, value]) => Buffer.from(value, "utf16le").swap16());
	const start = 6 + entries.length * 12;
	const table = Buffer.alloc(start + strings.reduce((sum, value) => sum + value.length, 0));
	table.writeUInt16BE(entries.length, 2);
	table.writeUInt16BE(start, 4);
	let position = start;
	entries.forEach(([id], index) => {
		const offset = 6 + index * 12;
		const data = strings[index];
		table.writeUInt16BE(3, offset);
		table.writeUInt16BE(1, offset + 2);
		table.writeUInt16BE(0x409, offset + 4);
		table.writeUInt16BE(id, offset + 6);
		table.writeUInt16BE(data.length, offset + 8);
		table.writeUInt16BE(position - start, offset + 10);
		data.copy(table, position);
		position += data.length;
	});
	return table;
}
test("fixed commands expose no renderer parameters, inherited environment, shell, or automation API", () => {
	const home = "/test/home with space; not code";
	const commands = ["linux", "darwin", "win32"].map((platform) =>
		fontCommand(platform, home, { systemRoot: "C:\\Windows", windir: "C:\\Windows" }),
	);
	assert.deepEqual(
		commands.map((command) => command.file),
		["/usr/bin/fc-list", "/usr/bin/osascript", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
	);
	assert.deepEqual(commands[0].args, ["-f", FONTCONFIG_FORMAT]);
	assert.equal(
		commands.every((command) => !command.args.some((arg) => arg.includes(home))),
		true,
	);
	assert.equal(
		commands.every((command) => !("NODE_OPTIONS" in command.env) && !("FONTCONFIG_FILE" in command.env)),
		true,
	);
	assert.match(MAC_FONT_SCRIPT, /font\.isFixedPitch/);
	assert.doesNotMatch(MAC_FONT_SCRIPT, /Application\(|doShellScript|System Events/);
	assert.match(WINDOWS_FONT_SCRIPT, /GetFontStream/);
	assert.match(WINDOWS_FONT_SCRIPT, /-not \$uri.IsFile -or \$uri.IsUnc/);
	assert.match(WINDOWS_FONT_SCRIPT, /DriveType -ne \[System.IO.DriveType\]::Fixed/);
	assert.match(WINDOWS_FONT_SCRIPT, /GetAttributes\(\$current\) -band \[System.IO.FileAttributes\]::ReparsePoint/);
	assert.ok(
		WINDOWS_FONT_SCRIPT.indexOf("IsLocalFontUri $glyph.FontUri") <
			WINDOWS_FONT_SCRIPT.indexOf("$glyph.GetFontStream()"),
	);
	assert.equal(commands[2].env.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
	assert.doesNotMatch(WINDOWS_FONT_SCRIPT, /ExecutionPolicy|Invoke-Expression|Start-Process|Add-Type -TypeDefinition/);
	assert.throws(() => fontCommand("other", home), code("UNSUPPORTED"));
});
test("nonstandard, missing, relative, UNC or inconsistent Windows roots refuse before executing anything", async () => {
	let executions = 0;
	for (const host of [
		{},
		{ systemRoot: "C:\\Windows" },
		{ systemRoot: "D:\\Windows", windir: "D:\\Windows" },
		{ systemRoot: "C:\\Windows", windir: "D:\\Windows" },
		{ systemRoot: "Windows", windir: "Windows" },
		{ systemRoot: "\\\\host\\Windows", windir: "\\\\host\\Windows" },
		{ systemRoot: "C:\\Windows\\..\\other", windir: "C:\\Windows" },
	]) {
		const service = new NativeFontService(
			"win32",
			() => {
				executions++;
				throw new Error("must not run");
			},
			host,
		);
		await assert.rejects(service.list(new AbortController().signal), code("UNSUPPORTED"));
	}
	assert.equal(executions, 0);
	const standard = fontCommand("win32", "C:\\Users\\example", { systemRoot: "c:\\windows\\", windir: "C:\\WINDOWS" });
	assert.equal(standard.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});
test("font process has deadline/output limits, no shell, and owned cancellation fences late success", async () => {
	let complete: (error: ExecFileException | null, stdout: string, stderr: string) => void = () => {};
	const kills: unknown[] = [];
	const command = fontCommand("linux", "/home/example");
	const operation = runFontProcess(command, (file, args, options, callback) => {
		assert.equal(file, command.file);
		assert.deepEqual(args, command.args);
		assert.equal(options.shell, false);
		assert.equal(options.timeout, NATIVE_FONT_LIMITS.timeoutMs);
		assert.equal(options.maxBuffer, NATIVE_FONT_LIMITS.outputBytes);
		assert.equal(options.killSignal, "SIGKILL");
		assert.equal(options.env, command.env);
		complete = callback;
		return {
			kill: (signal) => {
				kills.push(signal);
				return true;
			},
		};
	});
	operation.cancel();
	operation.cancel();
	assert.deepEqual(kills, ["SIGKILL"]);
	complete(null, linux, "");
	await assert.rejects(operation.result, code("CLOSED"));
});
test("missing executables, denied access, timeout and oversized output have truthful bounded errors", async () => {
	for (const [native, expected] of [
		["ENOENT", "UNSUPPORTED"],
		["EACCES", "DENIED"],
		["EPERM", "DENIED"],
		["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "FAILED"],
		["ETIMEDOUT", "FAILED"],
	]) {
		const operation = runFontProcess(fontCommand("linux", "/home/example"), (_file, _args, _options, callback) => {
			queueMicrotask(() =>
				callback(Object.assign(new Error("private path never forwarded"), { code: native }), "", ""),
			);
			return { kill: () => true };
		});
		await assert.rejects(operation.result, code(expected));
	}
	assert.throws(() => parseNativeFonts("linux", " ".repeat(NATIVE_FONT_LIMITS.outputBytes + 1)), code("FAILED"));
	assert.throws(() => parseNativeFonts("win32", '{"error":"DENIED"}'), code("DENIED"));
});
test("process diagnostics classify observed exits without claiming that a killed child timed out", async () => {
	for (const [native, killed, expected] of [
		["ENOENT", false, "missing"],
		["EACCES", false, "denied"],
		["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", true, "output-limit"],
		["ETIMEDOUT", true, "timeout"],
		[1, false, "nonzero"],
		[null, true, "failed"],
		["private-code", false, "failed"],
	] as const) {
		const records: FontDiagnostic[] = [];
		const operation = runFontProcess(
			fontCommand("linux", "/private-home"),
			(_file, _args, _options, callback) => {
				queueMicrotask(() =>
					callback(
						Object.assign(new Error("private-message"), { code: native, killed, path: "/private-path" }),
						"private-font-output",
						"private-stderr",
					),
				);
				return { kill: () => true };
			},
			(record) => records.push(record),
		);
		await assert.rejects(operation.result, AppearanceError);
		assert.equal(records.length, 1);
		const record = records[0];
		assert.equal(record.phase, "process");
		if (record.phase !== "process") assert.fail("Expected process diagnostic");
		assert.equal(record.outcome, expected);
		assert.equal(record.killed, killed);
		assert.equal(record.cancelled, false);
		assert.equal(record.exit, typeof native === "number" ? native : null);
		assert.ok(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 86400000);
		assert.doesNotMatch(JSON.stringify(records), /private/);
	}
});
test("parser and script diagnostics distinguish bounded failure stages and reject forged fields", () => {
	for (const [output, expected] of [
		["private-font-output", { phase: "parser", outcome: "json" }],
		["[]", { phase: "parser", outcome: "envelope" }],
		['{"error":"FAILED","stage":"assembly"}', { phase: "script", outcome: "FAILED", stage: "assembly" }],
		['{"error":"DENIED","stage":"font-stream"}', { phase: "script", outcome: "DENIED", stage: "font-stream" }],
		['{"error":"FAILED","stage":"/private-path"}', { phase: "parser", outcome: "envelope" }],
		['{"error":"FAILED","stage":"glyph","secret":"private"}', { phase: "parser", outcome: "envelope" }],
		['{"error":"FAILED","stage":{"private":"data"}}', { phase: "parser", outcome: "envelope" }],
	] as const) {
		const records: FontDiagnostic[] = [];
		assert.throws(
			() => parseNativeFonts("win32", output, (record) => records.push(record)),
			code(output.includes('"DENIED"') ? "DENIED" : "FAILED"),
		);
		assert.deepEqual(records, [expected]);
		assert.doesNotMatch(JSON.stringify(records), /private|secret/);
	}
});
test("diagnostic sink failures cannot change success, failure, cancellation, or request admission", async () => {
	const brokenSink = () => {
		throw new Error("private-diagnostic-failure");
	};
	assert.deepEqual(parseNativeFonts("linux", linux, brokenSink), parseNativeFonts("linux", linux));
	assert.throws(() => parseNativeFonts("win32", "invalid", brokenSink), code("FAILED"));
	for (const cancelled of [false, true]) {
		let complete: (error: ExecFileException | null, stdout: string, stderr: string) => void = () => {};
		const service = new NativeFontService("linux", (command) =>
			runFontProcess(
				command,
				(_file, _args, _options, callback) => {
					complete = callback;
					return { kill: () => true };
				},
				brokenSink,
			),
		);
		const controller = new AbortController();
		const pending = service.list(controller.signal);
		if (cancelled) controller.abort();
		await assert.rejects(service.list(new AbortController().signal), code("BUSY"));
		complete(null, linux, "");
		if (cancelled) await assert.rejects(pending, code("CLOSED"));
		else assert.equal((await pending).families.length, 1);
		const next = service.list(new AbortController().signal);
		complete(null, linux, "");
		assert.equal((await next).families.length, 1);
	}
});
test("fontconfig spacing and macOS metadata keep known and unknown traits distinct without name guessing", () => {
	const catalog = parseNativeFonts("linux", linux);
	assert.deepEqual(catalog, { families: [{ family: face.family, faces: [face], monospace: true }], truncated: false });
	assert.equal(parseNativeFonts("linux", linux.replace("100", "")).families[0]?.monospace, null);
	assert.equal(parseNativeFonts("linux", linux.replace("100", "90")).families[0]?.monospace, false);
	assert.equal(parseNativeFonts("linux", linux.replace("100", "110")).families[0]?.monospace, true);
	// Synthetic AppKit response, not a native macOS fixture.
	const mac = parseNativeFonts("darwin", JSON.stringify({ rows: [{ face, monospace: false }], truncated: false }));
	assert.equal(mac.families[0]?.monospace, false); // "Mono" in the name is not evidence.
	assert.deepEqual(parseInstalledFontCatalog(catalog), catalog);
	assert.equal(parseFontReply({ ok: true, result: catalog }).families.length, 1);
});
test("OpenType metadata uses official name IDs and rejects missing, malformed, oversized, or injected identities", () => {
	const table = nameTable();
	assert.deepEqual(openTypeFontNames(table.toString("base64")), face);
	const extended = nameTable([
		[1, "Legacy"],
		[2, "Regular"],
		[4, face.fullName],
		[6, face.postscriptName],
		[16, face.family],
		[17, face.style],
	]);
	assert.deepEqual(openTypeFontNames(extended.toString("base64")), face);
	for (const invalid of [
		"not base64",
		Buffer.alloc(65537).toString("base64"),
		nameTable([[1, face.family]]).toString("base64"),
	])
		assert.throws(() => openTypeFontNames(invalid), AppearanceError);
	const badOffset = Buffer.from(table);
	badOffset.writeUInt16BE(65535, 16);
	assert.throws(() => openTypeFontNames(badOffset.toString("base64")), AppearanceError);
	const windows = parseNativeFonts(
		"win32",
		JSON.stringify({ tables: [{ name: table.toString("base64"), monospace: true }], truncated: false }),
	);
	assert.deepEqual(windows.families[0]?.faces, [face]);
	assert.equal(windows.families[0]?.monospace, true);
});
test("malformed rows, parser limits and catalog identity consistency never fabricate usable fonts", () => {
	const malformed = parseNativeFonts("linux", `${linux}unsafe\x1fno\x1ffull\x1fRegular\x1f100\x1fextra\x1e`);
	assert.equal(malformed.families.length, 1);
	assert.equal(malformed.truncated, true);
	const massive = parseNativeFonts(
		"linux",
		Array.from(
			{ length: 2050 },
			(_, n) => `Family${n}\x1fFamily${n} Regular\x1fPostscript${n}\x1fRegular\x1f100\x1e`,
		).join(""),
	);
	assert.equal(massive.families.length, 512);
	assert.equal(massive.truncated, true);
	for (const output of ["not json", "[]", '{"rows":[],"truncated":false,"path":"extra"}'])
		assert.throws(() => parseNativeFonts("darwin", output), AppearanceError);
	for (const group of [
		{ family: "Mismatch", faces: [face], monospace: true },
		{ family: face.family, faces: [face, face], monospace: true },
		{ family: face.family, faces: [], monospace: null },
		{ family: face.family, faces: [face], monospace: "unknown" },
	])
		assert.throws(() => parseInstalledFontCatalog({ families: [group], truncated: false }), AppearanceError);
});
test("one child admission survives cancellation until actual exit; stale results cannot reach renderer", async () => {
	let finish: (value: string) => void = () => {};
	let kills = 0;
	const service = new NativeFontService("linux", () => ({
		result: new Promise<string>((resolve) => {
			finish = resolve;
		}),
		cancel: () => {
			kills++;
		},
	}));
	const controller = new AbortController();
	const pending = service.list(controller.signal);
	controller.abort();
	assert.equal(kills, 1);
	await assert.rejects(service.list(new AbortController().signal), code("BUSY"));
	finish(linux);
	await assert.rejects(pending, code("CLOSED"));
	const next = service.list(new AbortController().signal);
	finish(linux);
	assert.equal((await next).families.length, 1);
});
test("owner/frame/origin admission, cancellation IDs and owner reset fence pending results", async () => {
	let finish: () => void = () => {};
	let signal: AbortSignal | undefined;
	let calls = 0;
	const requests = new FontRequests((current) => {
		calls++;
		signal = current;
		return new Promise((resolve) => {
			finish = () => resolve({ families: [], truncated: false });
		});
	});
	await assert.rejects(
		requests.request(id, () => false),
		code("DENIED"),
	);
	assert.equal(calls, 0);
	const pending = requests.request(id, () => true);
	requests.cancel("foreign id");
	assert.equal(signal?.aborted, false);
	await assert.rejects(
		requests.request(id, () => true),
		code("BUSY"),
	);
	requests.reset();
	assert.equal(signal?.aborted, true);
	finish();
	await assert.rejects(pending, code("CLOSED"));
	let trusted = true;
	const stale = requests.request(id, () => trusted);
	trusted = false;
	finish();
	await assert.rejects(stale, code("CLOSED"));
	assert.equal(decodeFontRequest(JSON.stringify({ version: 1, id })), id);
	for (const raw of ["", '{"version":1}', JSON.stringify({ version: 1, id, command: "exec" }), " ".repeat(129)])
		assert.throws(() => decodeFontRequest(raw), code("INVALID"));
});
test("desktop retains blanket browser permission denial and does not ship the old font permission exception", async () => {
	const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
	assert.match(main, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/);
	assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
	assert.doesNotMatch(main, /local-fonts|LocalFontPermission|Allow once/);
});
