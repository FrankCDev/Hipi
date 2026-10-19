import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { FILE_LIMITS, FileServiceError } from "../src/files/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-snapshot-"));
	let permitted = true;
	let onAuthorize: (() => Promise<void>) | undefined;
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {
			if (!permitted) throw new FileServiceError("UNAUTHORIZED");
			await onAuthorize?.();
		},
	});
	const root = await authority.grantRoot({
		principalId: "alice",
		workspaceId: "workspace",
		absolutePath: directory,
		writable: false,
	});
	return {
		directory,
		authority,
		root,
		target: { workspaceId: root.workspaceId, rootId: root.rootId, path: "document.bin" },
		source: authority.forPrincipalSnapshot("alice"),
		revokeWorkspace: () => {
			permitted = false;
		},
		onAuthorize: (hook: () => Promise<void>) => {
			onAuthorize = hook;
		},
		cleanup: async () => {
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("snapshot preserves binary bytes, hashes exact content and owns its buffer; public text limit stays fixed", async () => {
	const f = await fixture();
	try {
		const content = Buffer.alloc(FILE_LIMITS.bytes + 16);
		for (let i = 0; i < content.length; i++) content[i] = i % 256;
		await writeFile(join(f.directory, f.target.path), content);
		const snapshot = await f.source.read(f.target, content.length);
		assert.deepEqual(snapshot.bytes, Uint8Array.from(content));
		assert.equal(snapshot.bytes.buffer.byteLength, content.length);
		assert.equal(snapshot.revision, createHash("sha256").update(content).digest("hex"));
		snapshot.bytes.fill(0);
		assert.deepEqual((await f.source.read(f.target, content.length)).bytes, Uint8Array.from(content));
		await assert.rejects(f.authority.forPrincipal("alice").readText(f.target), { code: "LIMIT_EXCEEDED" });
		await assert.rejects(f.source.read(f.target, content.length - 1), { code: "LIMIT_EXCEEDED" });
		for (const budget of [0, -1, 0.5, Number.NaN, Infinity, 20 * 1024 * 1024 + 1]) {
			await assert.rejects(f.source.read(f.target, budget), { code: "LIMIT_EXCEEDED" });
		}
		await writeFile(join(f.directory, f.target.path), Buffer.alloc(20 * 1024 * 1024));
		assert.equal((await f.source.read(f.target, 20 * 1024 * 1024)).bytes.length, 20 * 1024 * 1024);
		await writeFile(join(f.directory, f.target.path), Buffer.alloc(20 * 1024 * 1024 + 1));
		await assert.rejects(f.source.read(f.target, 20 * 1024 * 1024), { code: "LIMIT_EXCEEDED" });
		await writeFile(join(f.directory, f.target.path), Buffer.alloc(0));
		const empty = await f.source.read(f.target, 1);
		assert.equal(empty.bytes.length, 0);
		assert.equal(empty.revision, createHash("sha256").update("").digest("hex"));
	} finally {
		await f.cleanup();
	}
});

test("snapshot and public text operations share one bounded admission pool", async () => {
	const f = await fixture();
	const gate = Promise.withResolvers<void>();
	let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
	try {
		await writeFile(join(f.directory, f.target.path), "safe");
		f.onAuthorize(() => gate.promise);
		results = Promise.allSettled(Array.from({ length: FILE_LIMITS.concurrent }, () => f.source.read(f.target, 16)));
		await assert.rejects(f.source.read(f.target, 16), { code: "BUSY" });
		await assert.rejects(f.source.assertAuthorized(f.target), { code: "BUSY" });
		await assert.rejects(f.authority.forPrincipal("alice").readText(f.target), { code: "BUSY" });
		gate.resolve();
		assert.ok((await results).every((result) => result.status === "fulfilled"));
	} finally {
		gate.resolve();
		await results;
		await f.cleanup();
	}
});

test("snapshot binds principal/workspace/grant; cached access rechecks workspace revocation", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.directory, f.target.path), Buffer.from([0, 255]));
		await assert.rejects(f.authority.forPrincipalSnapshot("other").read(f.target, 16), { code: "UNAUTHORIZED" });
		await assert.rejects(f.source.read({ ...f.target, workspaceId: "other" }, 16), { code: "UNAUTHORIZED" });
		await assert.rejects(f.source.read({ ...f.target, rootId: "other" }, 16), { code: "UNAUTHORIZED" });
		await f.source.read(f.target, 16);
		await f.source.assertAuthorized(f.target);
		f.revokeWorkspace();
		await assert.rejects(f.source.assertAuthorized(f.target), { code: "UNAUTHORIZED" });
		await assert.rejects(f.source.read(f.target, 16), { code: "UNAUTHORIZED" });
	} finally {
		await f.cleanup();
	}
});

test("revocation before publication rejects read and close drains pending checks", async () => {
	for (const mode of ["revoke", "close"] as const) {
		const f = await fixture();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		try {
			await writeFile(join(f.directory, f.target.path), Buffer.from([0, 255]));
			let checks = 0;
			f.onAuthorize(async () => {
				if (++checks === 2) {
					reached.resolve();
					await gate.promise;
				}
			});
			const pending = f.source.read(f.target, 16);
			const rejected = assert.rejects(pending, { code: "UNAUTHORIZED" });
			await reached.promise;
			let drained = false;
			const closing =
				mode === "close"
					? f.authority.close().then(() => {
							drained = true;
						})
					: undefined;
			if (mode === "revoke") f.authority.revokeRoot(f.root.rootId);
			await Promise.resolve();
			assert.equal(drained, false);
			gate.resolve();
			await rejected;
			await closing;
			await assert.rejects(f.source.assertAuthorized(f.target), {
				code: mode === "close" ? "CLOSED" : "UNAUTHORIZED",
			});
			await assert.rejects(f.source.read(f.target, 16), { code: mode === "close" ? "CLOSED" : "UNAUTHORIZED" });
		} finally {
			gate.resolve();
			await f.cleanup();
		}
	}
});

test("snapshot rejects directories, symlinks, hardlinks, traversal and replaced root", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.directory, f.target.path), Buffer.from([0, 255]));
		await mkdir(join(f.directory, "folder"));
		await symlink(f.target.path, join(f.directory, "alias"));
		await link(join(f.directory, f.target.path), join(f.directory, "hardlink"));
		for (const path of ["folder", "alias", "hardlink", f.target.path]) {
			await assert.rejects(f.source.read({ ...f.target, path }, 16), { code: "BLOCKED_RESOURCE" });
		}
		await assert.rejects(f.source.read({ ...f.target, path: "../outside" }, 16), { code: "INVALID_PATH" });
		await rm(f.directory, { recursive: true });
		await symlink(tmpdir(), f.directory, "dir");
		await assert.rejects(f.source.read(f.target, 16), { code: "BLOCKED_RESOURCE" });
	} finally {
		await f.cleanup();
	}
});

test("snapshot rejects an actual file mutation during the bounded read", async (context) => {
	const f = await fixture();
	try {
		const filename = join(f.directory, f.target.path);
		await writeFile(filename, Buffer.from([0, 255]));
		const probe = await open(filename, "r");
		const prototype: FileHandle = Object.getPrototypeOf(probe);
		const originalStat = prototype.stat;
		await probe.close();
		let calls = 0;
		context.mock.method(prototype, "stat", async function (this: FileHandle) {
			const result = await originalStat.call(this);
			if (++calls === 1) await writeFile(filename, Buffer.from([0, 255, 128]));
			return result;
		});
		await assert.rejects(f.source.read(f.target, 16), { code: "VERSION_CONFLICT" });
	} finally {
		context.mock.restoreAll();
		await f.cleanup();
	}
});

test("root display names are basename-only and omit control/format characters", async () => {
	const f = await fixture();
	try {
		assert.equal(f.root.displayName, basename(f.directory));
		assert.deepEqual(await f.authority.forPrincipal("alice").listRoots("workspace"), [f.root]);
		for (const name of ["project\nname", "project\u202ename"]) {
			const directory = join(f.directory, name);
			await mkdir(directory);
			const root = await f.authority.grantRoot({
				principalId: "alice",
				workspaceId: "workspace",
				absolutePath: directory,
				writable: false,
			});
			assert.equal("displayName" in root, false);
			const listed = await f.authority.forPrincipal("alice").listRoots("workspace");
			assert.equal("displayName" in listed[listed.length - 1], false);
		}
	} finally {
		await f.cleanup();
	}
});
