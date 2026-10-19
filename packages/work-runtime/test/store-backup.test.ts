import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, { link, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage, openNodeSqliteStorageReadOnly } from "@earendil-works/pi-durable/storage/sqlite/node";
import { backupStore } from "../src/maintenance/backup.ts";
import { syncPath } from "../src/maintenance/paths.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { parseBackupManifest, verifyBackup } from "../src/maintenance/verify.ts";
import { StoreOwnerLease } from "../src/store-owner.ts";
import { openTestRuntime } from "../src/testing.ts";

async function fixture() {
	// Normalize only the fixture root; maintenance must still reject explicit aliases below it.
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-backup-test-")));
	const source = join(parent, "source"),
		destination = join(parent, "backup");
	const runtime = await openTestRuntime(source);
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" });
	await runtime.call("createConversation", { workspaceId: "work", requestId: "create", title: "Preserved" });
	await runtime.close();
	return { parent, source, destination };
}
async function businessBytes(source: string) {
	const output: Record<string, string> = {};
	for (const relative of ["catalog.sqlite", "work/workspace.sqlite"]) {
		for (const suffix of ["", "-wal"]) {
			try {
				const bytes = await readFile(
					join(source, relative + suffix),
				); /* SQLite may create an empty WAL on a read-only open; it contains no business bytes. */
				if (suffix !== "-wal" || bytes.length)
					output[relative + suffix] = createHash("sha256").update(bytes).digest("hex");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	}
	return output;
}
test("backup freezes the catalog union and preserves source bytes and unknown durable facts", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.source, "credentials.enc"), "not included");
		const db = new DatabaseSync(join(f.source, "catalog.sqlite"));
		db.prepare("INSERT INTO workspaces VALUES ('empty','Not created',0)").run();
		db.prepare("UPDATE workspaces SET ready=0 WHERE workspace_id='work'").run();
		db.close();
		const writer = await openNodeSqliteStorage(join(f.source, "work/workspace.sqlite"));
		const unknownId = await writer.mintId<DocumentId>();
		await writer.commit(
			[
				{
					type: "document.create",
					record: { id: unknownId, kind: "unknown.business-fact", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { preserved: "unrecognized business fact", pending: true } },
				},
			],
			BACKGROUND_CONTEXT,
		);
		await writer.close(BACKGROUND_CONTEXT);
		const before = await businessBytes(f.source);
		const result = await backupStore(f);
		const reader = await openNodeSqliteStorageReadOnly(join(f.destination, "workspaces/work.sqlite"));
		assert.deepEqual((await reader.document(unknownId, "current", BACKGROUND_CONTEXT))?.value, {
			preserved: "unrecognized business fact",
			pending: true,
		});
		await reader.close(BACKGROUND_CONTEXT);
		assert.deepEqual(await businessBytes(f.source), before);
		assert.equal(result.workspaceCount, 1);
		assert.equal(result.manifest.workspaces[0].registration, "reserved");
		assert.deepEqual(result.manifest.reservations, [{ workspaceId: "empty", name: "Not created" }]);
		assert.equal(
			result.manifest.files.some((f) => f.path.includes("owner") || f.path.includes("credentials")),
			false,
		);
		assert.equal((await verifyBackup({ directory: f.destination })).manifestDigest, result.manifestDigest);
		assert.deepEqual((await readdir(f.destination)).sort(), [
			"catalog.sqlite",
			"manifest.json",
			"operation.json",
			"workspaces",
		]);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("verification rejects incomplete, changed, extra and missing files", async () => {
	const f = await fixture();
	try {
		await backupStore(f);
		const path = join(f.destination, "manifest.json"),
			original = await readFile(path);
		await rm(path);
		await assert.rejects(verifyBackup({ directory: f.destination }), { code: "INCOMPLETE_BACKUP" });
		await writeFile(path, original);
		const manifest = JSON.parse(original.toString());
		manifest.files[0].sha256 = "0".repeat(64);
		await writeFile(path, JSON.stringify(manifest));
		await assert.rejects(verifyBackup({ directory: f.destination }), { code: "INTEGRITY_FAILED" });
		await writeFile(path, original);
		await writeFile(join(f.destination, "extra"), "extra");
		await assert.rejects(verifyBackup({ directory: f.destination }), { code: "INCOMPLETE_BACKUP" });
		await rm(join(f.destination, "extra"));
		await rm(join(f.destination, "workspaces/work.sqlite"));
		await assert.rejects(verifyBackup({ directory: f.destination }), { code: "INCOMPLETE_BACKUP" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("path collisions, overlap, aliases, unknown directories and schema4 fail closed", async () => {
	const f = await fixture();
	try {
		await mkdir(f.destination);
		await assert.rejects(backupStore(f), { code: "TARGET_EXISTS" });
		await assert.rejects(backupStore({ ...f, destination: join(f.source, "nested") }), { code: "INVALID_PATH" });
		await symlink(f.source, join(f.parent, "alias"), "dir");
		await assert.rejects(backupStore({ ...f, source: join(f.parent, "alias") }), { code: "INVALID_PATH" });
		await link(join(f.source, "work/workspace.sqlite"), join(f.parent, "hard"));
		await assert.rejects(backupStore(f), { code: "INVALID_PATH" });
		await rm(join(f.parent, "hard"));
		await mkdir(join(f.source, "unknown"));
		await assert.rejects(backupStore(f), { code: "INTEGRITY_FAILED" });
		await rm(join(f.source, "unknown"), { recursive: true });
		const db = new DatabaseSync(join(f.source, "catalog.sqlite"));
		db.exec("UPDATE identity SET version=4");
		db.close();
		await assert.rejects(backupStore(f), { code: "UNSUPPORTED_SCHEMA" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("real competing process keeps the same owner inode and returns BUSY", async () => {
	const f = await fixture();
	const script = join(f.parent, "owner.mjs");
	await writeFile(
		script,
		`import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); process.stdout.write('locked\\n'); setInterval(()=>{},1000);`,
	);
	const child = spawn(process.execPath, [script, join(f.source, "store-owner.sqlite")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		await once(child.stdout, "data");
		await assert.rejects(backupStore(f), { code: "BUSY" });
	} finally {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
	try {
		await backupStore(f);
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("committed WAL is captured without changing source main/WAL", async () => {
	const f = await fixture();
	const script = join(f.parent, "wal.mjs");
	await writeFile(
		script,
		`import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[2]); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE workspaces SET name='WAL reservation' WHERE workspace_id='work'; INSERT INTO workspaces VALUES ('wal','WAL only',0)"); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`,
	);
	const child = spawn(process.execPath, [script, join(f.source, "catalog.sqlite")], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	await once(child.stdout, "data");
	child.kill("SIGKILL");
	await once(child, "exit");
	try {
		const fix = new DatabaseSync(join(f.source, "catalog.sqlite"));
		try {
			fix.exec("PRAGMA wal_autocheckpoint=0; UPDATE workspaces SET name='Original' WHERE workspace_id='work'");
			const before = await businessBytes(f.source);
			const result = await backupStore(f);
			assert.deepEqual(await businessBytes(f.source), before);
			assert.deepEqual(result.manifest.reservations, [{ workspaceId: "wal", name: "WAL only" }]);
		} finally {
			fix.close();
		}
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("cancelled request creates no published backup", async () => {
	const f = await fixture();
	try {
		await assert.rejects(backupStore({ ...f, signal: AbortSignal.abort() }), { code: "CANCELLED" });
		await assert.rejects(readFile(join(f.destination, "manifest.json")), { code: "ENOENT" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("file flush failure preserves partial output and refuses success", async (t) => {
	const f = await fixture();
	const handle = await open(join(f.parent, "probe"), "w");
	const prototype = Object.getPrototypeOf(handle);
	await handle.close();
	const mock = t.mock.method(prototype, "sync", async () => {
		throw Object.assign(new Error("private path must not leak"), { code: "EIO" });
	});
	try {
		await assert.rejects(backupStore(f), (error) => {
			assert.equal(error instanceof Error && error.message.includes(f.source), false);
			return true;
		});
		mock.mock.restore();
		assert.ok((await readdir(f.destination)).length > 0);
		await assert.rejects(readFile(join(f.destination, "manifest.json")), { code: "ENOENT" });
		await backupStore({ ...f, destination: join(f.parent, "retry") });
	} finally {
		mock.mock.restore();
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("strict manifest rejects unknown fields, aliases, duplicates and oversized metadata before reads", async () => {
	const f = await fixture();
	try {
		const { manifest } = await backupStore(f);
		for (const change of [
			(m: Record<string, unknown>) => {
				m.extra = true;
			},
			(m: Record<string, unknown>) => {
				m.piSchema = 3;
			},
		]) {
			const altered: Record<string, unknown> = structuredClone(manifest);
			change(altered);
			assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify(altered))));
		}
		const pathAttack = structuredClone(manifest);
		pathAttack.files[0].path = "../catalog.sqlite";
		assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify(pathAttack))));
		const oversized = structuredClone(manifest);
		const operation = oversized.files.find((file) => file.path === "operation.json");
		assert.ok(operation);
		operation.bytes = 1025;
		assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify(oversized))), { code: "CAPACITY_EXCEEDED" });
		const duplicate = structuredClone(manifest);
		duplicate.reservations.push({ workspaceId: "WORK", name: "alias" });
		assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify(duplicate))));
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("source connection close failure retains root ownership until process termination", async () => {
	const f = await fixture();
	const script = join(f.parent, "close-failure.mjs");
	await writeFile(
		script,
		`
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { backupStore } from ${JSON.stringify(new URL("../src/maintenance/backup.ts", import.meta.url).href)};
const original = DatabaseSync.prototype.close;
let failed = false;
DatabaseSync.prototype.close = function () {
	if (!failed) { failed = true; throw new Error('close fixture'); }
	return original.call(this);
};
await assert.rejects(backupStore({ source: process.argv[2], destination: process.argv[3] }), { code: 'INTEGRITY_FAILED' });
DatabaseSync.prototype.close = original;
process.stdout.write('retained\\n');
setInterval(() => {}, 1000);
`,
	);
	const child = spawn(process.execPath, ["--conditions=source", script, f.source, f.destination], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = once(child, "exit");
	try {
		await Promise.race([
			once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) }),
			exited.then(() => {
				throw new Error("Close-failure fixture exited before retaining ownership");
			}),
		]);
		await assert.rejects(StoreOwnerLease.acquire(f.source), { code: "WORKSPACE_BUSY" });
	} finally {
		// Retained failed-close resources are released only by actual process termination.
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		const reopened = await StoreOwnerLease.acquire(f.source);
		reopened.close();
		await rm(f.parent, { recursive: true, force: true });
	}
});
test("unexpected schema objects and ready records without data are never silently dropped", async () => {
	const f = await fixture();
	try {
		const db = new DatabaseSync(join(f.source, "work/workspace.sqlite"));
		db.exec("CREATE TABLE unexpected(value TEXT)");
		db.close();
		await assert.rejects(backupStore(f), { code: "UNSUPPORTED_SCHEMA" });
		await rm(join(f.source, "work/workspace.sqlite"));
		await assert.rejects(backupStore(f), { code: "INTEGRITY_FAILED" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("backup keeps the root lease while output flush is in flight and observes boundary cancellation", async (t) => {
	const f = await fixture();
	const handle = await open(join(f.parent, "probe"), "w");
	const prototype = Object.getPrototypeOf(handle);
	await handle.close();
	const original: () => Promise<void> = prototype.sync;
	let release: () => void = () => {};
	let entered: () => void = () => {};
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first = true;
	const mocked = t.mock.method(prototype, "sync", async function (this: unknown) {
		if (first) {
			first = false;
			entered();
			await gate;
		}
		return original.call(this);
	});
	const abort = new AbortController();
	const pending = backupStore({ ...f, signal: abort.signal });
	try {
		await waiting;
		const script = join(f.parent, "try-owner.mjs");
		await writeFile(
			script,
			`import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[2]);try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');process.stdout.write('unexpected');}catch{process.stdout.write('busy');}finally{db.close();}`,
		);
		const child = spawn(process.execPath, [script, join(f.source, "store-owner.sqlite")], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		await once(child, "exit");
		assert.equal(output, "busy");
		abort.abort();
		release();
		await assert.rejects(pending, { code: "CANCELLED" });
		mocked.mock.restore();
		await assert.rejects(readFile(join(f.destination, "manifest.json")), { code: "ENOENT" });
		const lease = await StoreOwnerLease.acquire(f.source);
		lease.close();
	} finally {
		release();
		mocked.mock.restore();
		await pending.catch(() => {});
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("producer release metadata does not change compatible backup schemas", async () => {
	const f = await fixture();
	try {
		const { manifest } = await backupStore(f);
		for (const producer of ["hipi-work/1.0.0-rc.1", "hipi-work/2.4.1+source.abcdef"]) {
			await writeFile(join(f.destination, "manifest.json"), JSON.stringify({ ...manifest, producer }));
			assert.equal((await verifyBackup({ directory: f.destination })).manifest.producer, producer);
		}
		for (const producer of ["hipi-work/01.0.0", "hipi-work/1.0.0-rc.01", "another-product/1.0.0"]) {
			assert.throws(() => parseBackupManifest(Buffer.from(JSON.stringify({ ...manifest, producer }))));
		}
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("catalog metadata is byte-budgeted before payload materialization", async () => {
	const f = await fixture();
	const path = join(f.source, "catalog.sqlite");
	try {
		const db = new DatabaseSync(path);
		const original = db.prepare("SELECT store_id,root FROM identity").get();
		assert.ok(original);
		for (const [column, value] of [
			["store_id", "a".repeat(129)],
			["root", "r".repeat(32769)],
		] as const) {
			db.prepare(`UPDATE identity SET ${column}=?`).run(value);
			assert.throws(() => inspectCatalog(path), { code: "CAPACITY_EXCEEDED" });
			db.prepare("UPDATE identity SET store_id=?,root=?").run(original.store_id, original.root);
		}
		db.prepare("UPDATE workspaces SET name=?").run("界".repeat(128));
		assert.equal(inspectCatalog(path).workspaces[0].name.length, 128);
		db.prepare("UPDATE workspaces SET name=?").run("界".repeat(129));
		assert.throws(() => inspectCatalog(path), { code: "CAPACITY_EXCEEDED" });
		db.prepare("UPDATE workspaces SET name='Original',workspace_id=?").run("w".repeat(129));
		assert.throws(() => inspectCatalog(path), { code: "CAPACITY_EXCEEDED" });
		db.prepare("UPDATE workspaces SET workspace_id='work'").run();
		db.exec(
			"WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<10000) INSERT INTO workspaces SELECT 'extra_'||n,'Reserved',0 FROM ids",
		);
		assert.throws(() => inspectCatalog(path), { code: "CAPACITY_EXCEEDED" });
		db.close();
		await assert.rejects(backupStore(f), { code: "CAPACITY_EXCEEDED" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("schema SQL bytes are screened before schema signature materialization", async () => {
	const f = await fixture();
	const path = join(f.source, "catalog.sqlite");
	try {
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE oversized_schema(value TEXT DEFAULT '${"x".repeat(65537)}')`);
		db.close();
		assert.throws(() => inspectCatalog(path), { code: "CAPACITY_EXCEEDED" });
		await assert.rejects(backupStore(f), { code: "CAPACITY_EXCEEDED" });
	} finally {
		await rm(f.parent, { recursive: true, force: true });
	}
});

test("flushing an existing output file preserves its bytes, identity and metadata", async () => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-flush-file-"));
	const path = join(parent, "output");
	try {
		const content = Buffer.from("existing output must never be truncated or rewritten");
		await writeFile(path, content);
		await fs.utimes(path, 1_700_000_000, 1_700_000_001);
		const before = await fs.stat(path, { bigint: true });
		await syncPath(path);
		const after = await fs.stat(path, { bigint: true });
		assert.equal(after.ino, before.ino);
		assert.equal(after.dev, before.dev);
		assert.equal(after.size, before.size);
		assert.equal(after.mode, before.mode);
		assert.equal(after.nlink, before.nlink);
		assert.equal(after.uid, before.uid);
		assert.equal(after.gid, before.gid);
		assert.equal(after.mtimeNs, before.mtimeNs);
		assert.equal(after.ctimeNs, before.ctimeNs);
		assert.equal(after.atimeNs, before.atimeNs);
		assert.deepEqual(await readFile(path), content);
		await assert.rejects(syncPath(join(parent, "missing")), { code: "ENOENT" });
		await assert.rejects(fs.stat(join(parent, "missing")), { code: "ENOENT" });
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("flush selects platform-specific existing-path handles and propagates open failures", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-flush-flags-"));
	const path = join(parent, "output");
	await writeFile(path, "fixture");
	const calls: { path: unknown; flags: unknown }[] = [];
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platformDescriptor);
	const mocked = t.mock.method(fs, "open", async (target: unknown, flags: unknown) => {
		calls.push({ path: target, flags });
		throw Object.assign(new Error("injected open failure"), { code: "EPERM" });
	});
	syncBuiltinESMExports();
	try {
		for (const platform of ["win32", "linux", "darwin"]) {
			Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
			calls.length = 0;
			await assert.rejects(syncPath(path), { code: "EPERM" });
			await assert.rejects(syncPath(parent), { code: "EPERM" });
			assert.deepEqual(calls, [
				{ path, flags: "r+" },
				{ path: parent, flags: platform === "win32" ? "r+" : "r" },
			]);
		}
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
		mocked.mock.restore();
		syncBuiltinESMExports();
		await rm(parent, { recursive: true, force: true });
	}
});

test("directory sync failure closes the handle and never becomes a durability guarantee", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-flush-directory-"));
	let failureCode = "EIO";
	let closed = 0;
	const mocked = t.mock.method(fs, "open", async () => ({
		sync: async () => {
			throw Object.assign(new Error("injected directory sync failure"), { code: failureCode });
		},
		close: async () => {
			closed++;
		},
	}));
	syncBuiltinESMExports();
	try {
		for (const code of ["EIO", "EPERM"]) {
			failureCode = code;
			await assert.rejects(syncPath(parent), (error) => {
				assert.ok(error instanceof Error);
				assert.equal("code" in error && error.code, "DURABILITY_UNVERIFIED");
				assert.ok(error.cause instanceof Error);
				assert.equal("code" in error.cause && error.cause.code, code);
				return true;
			});
		}
		assert.equal(closed, 2);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
		await rm(parent, { recursive: true, force: true });
	}
});
