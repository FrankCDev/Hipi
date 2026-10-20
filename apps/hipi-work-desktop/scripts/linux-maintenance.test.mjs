import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import maintenance from "../packaging/linux-maintenance.cjs";
import artifacts from "../packaging/verify-linux-artifacts.cjs";
import { assertOriginalStoreUnchanged } from "./smoke-store-invariants.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const launcher = await readFile(new URL("../packaging/hipi-work-maintenance", import.meta.url));
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const tar = builderRequire("tar");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("original-store checks preserve every existing byte and permit only new empty SQLite sidecar pairs", () => {
	const database = { file: "work/workspace.sqlite", bytes: 100, sha256: hash("original database") };
	const before = [database];
	const wal = { file: `${database.file}-wal`, bytes: 0, sha256: hash("") };
	const shm = { file: `${database.file}-shm`, bytes: 32768, sha256: hash("transient index") };
	assert.deepEqual(assertOriginalStoreUnchanged(before, before), []);
	assert.deepEqual(assertOriginalStoreUnchanged(before, [...before, shm, wal]), [shm, wal]);
	for (const after of [
		[{ ...database, sha256: hash("changed database") }, shm, wal],
		[shm, wal],
		[database, shm, { ...wal, bytes: 32 }],
		[database, { ...shm, bytes: 65536 }, wal],
		[database, wal],
		[database, { ...wal, file: "credentials.enc" }],
		[database, { ...shm, file: "unknown.sqlite-shm" }, { ...wal, file: "unknown.sqlite-wal" }],
	])
		assert.throws(() => assertOriginalStoreUnchanged(before, after));
	const existingWal = { ...wal, bytes: 1024, sha256: hash("committed WAL business bytes") };
	assert.throws(() => assertOriginalStoreUnchanged([database, existingWal], [database, wal]));
	assert.throws(() => assertOriginalStoreUnchanged([database, existingWal], [database]));
});

test("Linux hardening is explicit and leaves Windows/macOS configuration untouched", () => {
	for (const platform of ["win32", "darwin"]) assert.deepEqual(maintenance.linuxPackagingOptions(root, platform), {});
	assert.deepEqual(maintenance.linuxPackagingOptions(root, "linux").electronFuses, {
		runAsNode: false,
		enableNodeOptionsEnvironmentVariable: false,
		enableNodeCliInspectArguments: false,
		onlyLoadAppFromAsar: true,
	});
	maintenance.assertRuntimeTarget("linux", "x64");
	assert.throws(() => maintenance.assertRuntimeTarget("linux", "arm64"), /not been reviewed/);
	assert.throws(() => maintenance.assertRuntimeTarget("win32", "x64"), /not been reviewed/);
});

test(
	"final Linux fuse inspection rejects every unsafe or missing required state",
	{ skip: process.platform !== "linux" },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-fuses-"));
		try {
			const file = join(directory, "inert-wire");
			const safe = Buffer.concat([
				Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
				Buffer.from([1, 8, 48, 48, 48, 48, 48, 49, 48, 48]),
			]);
			await writeFile(file, safe, { mode: 0o755 });
			assert.deepEqual(await maintenance.verifyLinuxFuses(file), maintenance.linuxFuses);
			for (const index of [0, 2, 3, 5]) {
				const changed = Buffer.from(safe);
				changed[34 + index] = changed[34 + index] === 48 ? 49 : 48;
				await writeFile(file, changed);
				await assert.rejects(maintenance.verifyLinuxFuses(file), /Unsafe Linux Electron fuse/);
			}
			await writeFile(file, "no fuse wire");
			await assert.rejects(maintenance.verifyLinuxFuses(file), /Could not find sentinel/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("runtime preparation rejects unauthenticated archive before extraction", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-node-pin-"));
	try {
		const archive = join(directory, "untrusted.tar.xz");
		await writeFile(archive, "not the official Node archive");
		await assert.rejects(
			maintenance.prepareMaintenanceRuntime(archive, join(directory, "runtime")),
			/archive digest mismatch/,
		);
		await assert.rejects(lstat(join(directory, "runtime")), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"official Linux runtime retains full notices and rejects extras, symlinks, tampering and executable mode drift",
	{ skip: process.platform !== "linux" },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-node-runtime-"));
		try {
			const source = join(root, ".artifacts/hipi-work/maintenance-runtime");
			const expected = await maintenance.verifyMaintenanceRuntime(source);
			assert.equal(expected.sha256, maintenance.pin.sha256);
			await cp(source, join(directory, "runtime"), { recursive: true });
			const runtime = join(directory, "runtime");
			const license = join(runtime, "LICENSE");
			const original = await readFile(license);
			assert.ok(original.length > 150_000, "Complete Node combined license and third-party notices must be retained");
			await maintenance.verifyMaintenanceRuntime(runtime);
			await writeFile(join(runtime, "npm"), "unreviewed extra payload");
			await assert.rejects(maintenance.verifyMaintenanceRuntime(runtime), /Unexpected maintenance runtime payload/);
			await rm(join(runtime, "npm"));
			await writeFile(license, "truncated notice");
			await assert.rejects(maintenance.verifyMaintenanceRuntime(runtime), /digest/);
			await writeFile(license, original);
			await chmod(join(runtime, "bin/node"), 0o644);
			await assert.rejects(maintenance.verifyMaintenanceRuntime(runtime), /file mode/);
			await chmod(join(runtime, "bin/node"), 0o755);
			await rm(license);
			await symlink(join(source, "LICENSE"), license);
			await assert.rejects(maintenance.verifyMaintenanceRuntime(runtime), /Unexpected maintenance runtime entry/);
			await symlink(source, join(directory, "linked-runtime"));
			await assert.rejects(
				maintenance.verifyMaintenanceRuntime(join(directory, "linked-runtime")),
				/must not be a symlink/,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"maintenance shell fixes runtime/entry paths, preserves arguments, clears Node injection and never falls back",
	{ skip: process.platform !== "linux" },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "Hipi 维护 shell-"));
		try {
			await mkdir(join(directory, "resources/maintenance-runtime/bin"), { recursive: true });
			const file = join(directory, "hipi-work-maintenance");
			await writeFile(file, launcher, { mode: 0o755 });
			const node = join(directory, "resources/maintenance-runtime/bin/node");
			await writeFile(
				node,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell expansion, not a JavaScript template.
				'#!/bin/sh\nprintf "node-options=%s\\nnode-path=%s\\nextra-ca=%s\\nelectron=%s\\n" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" "${NODE_EXTRA_CA_CERTS-unset}" "${ELECTRON_RUN_AS_NODE-unset}"\nprintf "%s\\n" "$@"\nexit 73\n',
				{ mode: 0o755 },
			);
			await writeFile(join(directory, "node"), '#!/bin/sh\necho "wrong runtime"\n', { mode: 0o755 });
			await writeFile(join(directory, "readlink"), "#!/bin/sh\nexit 41\n", { mode: 0o755 });
			await symlink(file, join(directory, "linked-launcher"));
			const run = () =>
				spawnSync("/bin/sh", [join(directory, "linked-launcher"), "history", "中文 with spaces", "--inspect"], {
					encoding: "utf8",
					timeout: 5000,
					env: {
						PATH: directory,
						APPDIR: "/wrong",
						NODE_OPTIONS: "--require=/wrong",
						NODE_PATH: "/wrong",
						NODE_EXTRA_CA_CERTS: "/wrong",
						ELECTRON_RUN_AS_NODE: "1",
					},
				});
			const result = run();
			assert.equal(result.status, 73, result.stderr);
			assert.equal(
				result.stdout,
				`node-options=unset\nnode-path=unset\nextra-ca=unset\nelectron=unset\n${directory}/resources/app.asar.unpacked/dist/maintenance.mjs\nhistory\n中文 with spaces\n--inspect\n`,
			);
			await rm(node);
			const absent = run();
			assert.notEqual(absent.status, 0);
			assert.equal(absent.stdout, "");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("final AppImage critical binding rejects mismatched binary bytes, missing files and unsafe metadata", () => {
	const bytes = Buffer.from("reviewed final executable");
	const item = { file: "hipi-work", bytes: bytes.length, mode: 0o755, sha256: hash(bytes) };
	const listing = `Path = hipi-work\nMode = -rwxr-xr-x\nFolder = -\nUser ID = 0\nGroup ID = 0\nSize = ${bytes.length}`;
	artifacts.assertAppImageCriticalFiles(listing, () => bytes, [item]);
	for (const changed of [
		"",
		`${listing}\n\n${listing}`,
		listing.replace("-rwxr-xr-x", "-rwsr-xr-x"),
		`${listing}\nUser ID = 1`,
		listing.replace("Group ID = 0", "Group ID = 1000"),
	])
		assert.throws(() => artifacts.assertAppImageCriticalFiles(changed, () => bytes, [item]));
	assert.throws(
		() => artifacts.assertAppImageCriticalFiles(listing, () => Buffer.alloc(bytes.length), [item]),
		/digest/,
	);
});

test("final tar reader checks actual critical bytes, omitted portable ownership, unique paths and safe modes without extracting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-tar-binding-"));
	try {
		const name = "Hipi-Work-0.0.1-linux-x64-unsigned";
		const bytes = Buffer.from("inert archive fixture");
		const archive = join(directory, `${name}.tar.gz`);
		const expected = [{ file: "hipi-work", mode: 0o755, bytes: bytes.length, sha256: hash(bytes) }];
		const writeArchive = async (records) => {
			const blocks = records.flatMap((record) => {
				const header = new tar.Header({
					path: `${name}/hipi-work`,
					type: "File",
					mode: 0o755,
					size: bytes.length,
					...record.header,
				});
				header.encode();
				const content = record.bytes ?? bytes;
				return [header.block, content, Buffer.alloc((512 - (content.length % 512)) % 512)];
			});
			await writeFile(archive, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
		};
		await writeArchive([{}]);
		artifacts.verifyLinuxTar(archive, expected);
		await writeArchive([{ bytes: Buffer.alloc(bytes.length) }]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /digest/);
		for (const mode of [0o644, 0o777, 0o4755]) {
			await writeArchive([{ header: { mode } }]);
			assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /mode/);
		}
		await writeArchive([{ header: { uid: 1000 } }]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /uid/);
		await writeArchive([{ header: { uid: 0, gid: 0 } }]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /uid/);
		await writeArchive([{ header: { uname: "root" } }]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /owner name/);
		await writeArchive([{}, {}]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /Duplicate/);
		await writeArchive([{ header: { path: `${name}/../hipi-work` } }]);
		assert.throws(() => artifacts.verifyLinuxTar(archive, expected), /ambiguous/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
