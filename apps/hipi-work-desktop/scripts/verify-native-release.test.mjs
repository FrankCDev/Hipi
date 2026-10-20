import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import {
	nativePayload,
	verifyMacSignature,
	verifyWindowsSignature,
	verifyZipPayload,
} from "./verify-native-release.mjs";

const mac = { version: "1.0.0", identity: "Example Company (ABCDEFGHIJ)", teamId: "ABCDEFGHIJ" };
const windows = { certificateSha1: "A".repeat(40), publisher: "Example Company" };

test("macOS gate independently requires bundle version, signature, identity, hardened runtime, staple and assessment", () => {
	const signature = `Identifier=org.hipi.work\nTeamIdentifier=${mac.teamId}\nAuthority=Developer ID Application: ${mac.identity}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nTimestamp=Oct 20, 2026 at 10:00:00\n`;
	const calls = [];
	const run = (binary, args) => {
		calls.push([binary, args]);
		if (binary.endsWith("PlistBuddy")) return { stdout: "1.0.0\n", stderr: "" };
		return {
			stdout: "",
			stderr: args.includes("--display")
				? signature
				: binary.endsWith("spctl")
					? "accepted\nsource=Notarized Developer ID\n"
					: "",
		};
	};
	assert.equal(verifyMacSignature("/inert/Hipi Work.app", mac, run).notarization, "verified");
	assert.equal(calls.length, 5);
	const callCount = calls.length;
	for (let index = 0; index < callCount; index++) {
		let current = 0;
		assert.throws(
			() =>
				verifyMacSignature("/inert/Hipi Work.app", mac, (binary, args) => {
					if (current++ === index) throw new Error("injected native failure");
					return run(binary, args);
				}),
			/injected/,
		);
	}
	for (const [from, to] of [
		["org.hipi.work", "org.other"],
		["ABCDEFGHIJ", "ZZZZZZZZZZ"],
		["Developer ID Application:", "Apple Development:"],
		["runtime", "adhoc"],
		["Timestamp=", "Signed Time="],
	])
		assert.throws(() =>
			verifyMacSignature("/inert/app", mac, (binary, args) =>
				args.includes("--display") ? { stdout: "", stderr: signature.replaceAll(from, to) } : run(binary, args),
			),
		);
	assert.throws(
		() =>
			verifyMacSignature("/inert/app", mac, (binary, args) =>
				binary.endsWith("PlistBuddy") ? { stdout: "2.0.0", stderr: "" } : run(binary, args),
			),
		/version/,
	);
	assert.throws(
		() =>
			verifyMacSignature("/inert/app", mac, (binary, args) =>
				binary.endsWith("spctl") ? { stdout: "accepted", stderr: "" } : run(binary, args),
			),
		/Notarized/,
	);
});

test(
	"native links reject multihop escapes, dangling targets and cycles",
	{ skip: process.platform === "win32" },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hipi-native-chain-"));
		const app = join(root, "app");
		try {
			await mkdir(join(app, "inside/sub"), { recursive: true });
			await mkdir(join(root, "outside"));
			await symlink("../..", join(app, "inside/sub/root"));
			await symlink("inside/sub/root/../outside", join(app, "escape"));
			await assert.rejects(nativePayload(app), /outside the application/);
			await rm(join(app, "escape"));
			await symlink("missing", join(app, "dangling"));
			await assert.rejects(nativePayload(app), { code: "ENOENT" });
			await rm(join(app, "dangling"));
			await symlink("cycle", join(app, "cycle"));
			await assert.rejects(nativePayload(app), { code: "ELOOP" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("Windows gate accepts only valid exact publisher, certificate, timestamp and requested version results", () => {
	const valid = {
		status: "Valid",
		thumbprint: windows.certificateSha1,
		publisher: windows.publisher,
		timestamped: true,
		version: "1.0.0",
	};
	const environment = { SYSTEMROOT: "/inert/windows" };
	const calls = [];
	const run = (binary, args) => {
		calls.push([binary, args]);
		return { stdout: JSON.stringify(valid), stderr: "" };
	};
	assert.equal(verifyWindowsSignature("/inert/app.exe", windows, run, environment, "1.0.0").signing, "verified");
	assert.ok(calls[0][1].includes("-NoProfile"));
	assert.ok(!calls[0][1].includes("-ExecutionPolicy"));
	for (const changed of [
		{ status: "UnknownError" },
		{ thumbprint: "B".repeat(40) },
		{ publisher: "Other" },
		{ timestamped: false },
		{ version: "2.0.0" },
	])
		assert.throws(
			() =>
				verifyWindowsSignature(
					"/inert/app.exe",
					windows,
					() => ({ stdout: JSON.stringify({ ...valid, ...changed }) }),
					environment,
					"1.0.0",
				),
			/mismatch/,
		);
	assert.throws(
		() =>
			verifyWindowsSignature(
				"/inert/app.exe",
				windows,
				() => {
					throw new Error("native failure");
				},
				environment,
				"1.0.0",
			),
		/native failure/,
	);
});

// A small uncompressed ZIP fixture writer, not an application archive reader.
function zipBytes(records) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const record of records) {
		const name = Buffer.from(record.file);
		const content = Buffer.from(record.content ?? "");
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc32(content), 14);
		header.writeUInt32LE(content.length, 18);
		header.writeUInt32LE(content.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, content);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50);
		entry.writeUInt16LE(0x0314, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc32(content), 16);
		entry.writeUInt32LE(content.length, 20);
		entry.writeUInt32LE(content.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(((record.mode ?? 0o100644) * 0x10000) >>> 0, 38);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);
		offset += header.length + name.length + content.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(records.length, 8);
	end.writeUInt16LE(records.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

test("ZIP verification binds every serialized file byte/type/mode without extracting paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-native-zip-"));
	const archive = join(root, "fixture.zip");
	const content = "signed fixture bytes";
	const expected = [
		{
			file: "Hipi Work.app/main",
			type: "file",
			mode: 0o644,
			bytes: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		},
	];
	try {
		const record = { file: expected[0].file, content, mode: 0o100644 };
		await writeFile(archive, zipBytes([record]));
		await verifyZipPayload(archive, expected, { unixModes: true });
		for (const records of [
			[],
			[record, record],
			[{ ...record, content: "different bytes" }],
			[{ ...record, mode: 0o100755 }],
			[{ ...record, mode: 0o120644 }],
			[{ ...record, file: "../outside" }],
			[{ ...record, file: "Hipi Work.app/./main" }],
			[record, { file: "unreviewed", content: "extra" }],
		]) {
			await writeFile(archive, zipBytes(records));
			await assert.rejects(verifyZipPayload(archive, expected, { unixModes: true }));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ZIP verifier preserves symlink semantics rather than accepting a same-byte regular file", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-native-link-"));
	const archive = join(root, "fixture.zip");
	const target = "Versions/Current";
	const expected = [
		{
			file: "Framework",
			type: "symlink",
			mode: 0o777,
			bytes: target.length,
			sha256: createHash("sha256").update(target).digest("hex"),
		},
	];
	try {
		await writeFile(archive, zipBytes([{ file: "Framework", content: target, mode: 0o120777 }]));
		await verifyZipPayload(archive, expected, { unixModes: true });
		await writeFile(archive, zipBytes([{ file: "Framework", content: target, mode: 0o100777 }]));
		await assert.rejects(verifyZipPayload(archive, expected, { unixModes: true }), /symlink type/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ZIP exact tree preserves empty directories and macOS directory modes", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-native-empty-dir-"));
	const archive = join(root, "fixture.zip");
	const expected = [{ file: "empty", type: "directory", mode: 0o755 }];
	try {
		await writeFile(archive, zipBytes([{ file: "empty/", mode: 0o040755 }]));
		await verifyZipPayload(archive, expected, { unixModes: true });
		await writeFile(archive, zipBytes([]));
		await assert.rejects(verifyZipPayload(archive, expected), /incomplete/);
		await assert.rejects(verifyZipPayload(archive, expected, { unixModes: true }), /incomplete/);
		await writeFile(archive, zipBytes([{ file: "empty/", mode: 0o040777 }]));
		await assert.rejects(verifyZipPayload(archive, expected, { unixModes: true }), /mode mismatch/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native inventory handles empty files and never follows framework links", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-native-tree-"));
	try {
		await mkdir(join(root, "payload"));
		await writeFile(join(root, "payload/empty"), "");
		if (process.platform !== "win32") await symlink("payload", join(root, "link"));
		const tree = await nativePayload(root);
		assert.equal(tree.find((item) => item.file === "payload/empty").bytes, 0);
		if (process.platform !== "win32") assert.equal(tree.find((item) => item.file === "link").type, "symlink");
		assert.equal(
			tree.some((item) => item.file.startsWith("link/")),
			false,
		);
		if (process.platform !== "win32") {
			await symlink("../outside", join(root, "escape"));
			await assert.rejects(nativePayload(root), /symlink escapes/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
