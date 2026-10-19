import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FILE_LIMITS, FileServiceError, validateRelativePath } from "../src/files/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-file-test-"));
	const rootPath = join(directory, "root");
	await mkdir(rootPath);
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async (principal, workspace) => {
			if (principal !== "alice" || workspace !== "workspace") throw new FileServiceError("UNAUTHORIZED");
		},
	});
	const root = await authority.grantRoot({
		principalId: "alice",
		workspaceId: "workspace",
		absolutePath: rootPath,
		writable: true,
	});
	return {
		directory,
		rootPath,
		authority,
		root,
		service: authority.forPrincipal("alice"),
		target: { ...root, path: "hello.txt" },
	};
}

test("path grammar rejects traversal, URI/encoding ambiguities and platform aliases", () => {
	for (const path of [
		"",
		"..",
		"a/../b",
		".",
		"/etc/passwd",
		"C:/data",
		"C:\\data",
		"\\\\host\\share",
		"%2e%2e/a",
		"%252e/a",
		"a\0b",
		"a//b",
		"a/",
		"a/./b",
		"NUL.txt",
		"aux",
		"LPT1",
		"x.",
		"x ",
		"file:stream",
		"a\nb",
		"a?b",
	]) {
		assert.throws(() => validateRelativePath(path), { code: "INVALID_PATH" }, path);
	}
	assert.equal(validateRelativePath("目录/hello world.ts"), "目录/hello world.ts");
	assert.equal(validateRelativePath("", true), "");
});

test("opaque grants enforce principal/workspace/read-only/revocation and hide canonical root", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.rootPath, "hello.txt"), "hello");
		assert.equal(JSON.stringify(f.root).includes(f.directory), false);
		await assert.rejects(f.authority.forPrincipal("mallory").readText(f.target), { code: "UNAUTHORIZED" });
		await assert.rejects(f.service.readText({ ...f.target, workspaceId: "other" }), { code: "UNAUTHORIZED" });
		await assert.rejects(f.service.readText({ ...f.target, rootId: "invented" }), { code: "UNAUTHORIZED" });
		const readonly = await f.authority.grantRoot({
			principalId: "alice",
			workspaceId: "workspace",
			absolutePath: f.rootPath,
			writable: false,
		});
		const content = await f.service.readText(f.target);
		await assert.rejects(f.service.saveText({ ...readonly, path: "hello.txt" }, "changed", content.revision), {
			code: "UNAUTHORIZED",
		});
		f.authority.revokeRoot(f.root.rootId);
		await assert.rejects(f.service.readText(f.target), { code: "UNAUTHORIZED" });
		assert.equal(await readFile(join(f.rootPath, "hello.txt"), "utf8"), "hello");
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("save preserves text/BOM/line endings and rejects stale revisions without overwriting external edits", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.rootPath, "hello.txt"), "\ufeff你好\r\n");
		const before = await f.service.readText(f.target);
		assert.equal(before.text, "\ufeff你好\r\n");
		const saved = await f.service.saveText(f.target, "\ufeffnew\r\n", before.revision);
		assert.deepEqual(saved, await f.service.readText(f.target));
		await writeFile(join(f.rootPath, "hello.txt"), "external edit");
		await assert.rejects(f.service.saveText(f.target, "unsaved user input", saved.revision), {
			code: "VERSION_CONFLICT",
		});
		assert.equal(await readFile(join(f.rootPath, "hello.txt"), "utf8"), "external edit");
		assert.deepEqual(await readdir(f.rootPath), ["hello.txt"]);
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("simultaneous writes through different grants cannot both consume one revision", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.rootPath, "hello.txt"), "original");
		const other = await f.authority.grantRoot({
			principalId: "alice",
			workspaceId: "workspace",
			absolutePath: f.rootPath,
			writable: true,
		});
		const before = await f.service.readText(f.target);
		const results = await Promise.allSettled([
			f.service.saveText(f.target, "first", before.revision),
			f.service.saveText({ ...other, path: "hello.txt" }, "second", before.revision),
		]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		assert.ok(["first", "second"].includes(await readFile(join(f.rootPath, "hello.txt"), "utf8")));
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("symlinks, hard links, non-files and replaced roots fail closed", async () => {
	const f = await fixture();
	try {
		const outside = join(f.directory, "outside.txt");
		await writeFile(outside, "private");
		await symlink(outside, join(f.rootPath, "hello.txt"));
		await assert.rejects(f.service.readText(f.target), { code: "BLOCKED_RESOURCE" });
		await symlink(f.directory, join(f.rootPath, "escape"), "dir");
		await assert.rejects(f.service.readText({ ...f.target, path: "escape/outside.txt" }), {
			code: "BLOCKED_RESOURCE",
		});
		await link(outside, join(f.rootPath, "hard.txt"));
		await assert.rejects(f.service.readText({ ...f.target, path: "hard.txt" }), { code: "BLOCKED_RESOURCE" });
		await mkdir(join(f.rootPath, "folder"));
		await assert.rejects(f.service.readText({ ...f.target, path: "folder" }), { code: "BLOCKED_RESOURCE" });
		await rm(f.rootPath, { recursive: true });
		await symlink(f.directory, f.rootPath, "dir");
		await assert.rejects(f.service.list({ ...f.target, path: "" }), { code: "BLOCKED_RESOURCE" });
		assert.equal(await readFile(outside, "utf8"), "private");
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("bounded UTF-8 reads reject binary, invalid encoding, unpaired surrogates and large files", async () => {
	const f = await fixture();
	try {
		for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from([65, 0, 66])]) {
			await writeFile(join(f.rootPath, "hello.txt"), bytes);
			await assert.rejects(f.service.readText(f.target), { code: "UNSUPPORTED_ENCODING" });
			assert.deepEqual(await f.service.preview(f.target), { kind: "unsupported", reason: "binary-or-encoding" });
		}
		await writeFile(join(f.rootPath, "hello.txt"), Buffer.alloc(FILE_LIMITS.bytes + 1, 65));
		await assert.rejects(f.service.readText(f.target), { code: "LIMIT_EXCEEDED" });
		await writeFile(join(f.rootPath, "hello.txt"), "normal");
		const original = await f.service.readText(f.target);
		await assert.rejects(f.service.saveText(f.target, "\ud800", original.revision), { code: "UNSUPPORTED_ENCODING" });
		await assert.rejects(f.service.saveText(f.target, "a".repeat(FILE_LIMITS.bytes + 1), original.revision), {
			code: "LIMIT_EXCEEDED",
		});
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("directory pages are bounded and changing directory invalidates cursor", async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < FILE_LIMITS.page + 1; i++)
			await writeFile(join(f.rootPath, `file-${i.toString().padStart(3, "0")}`), "");
		const target = { ...f.target, path: "" };
		const page = await f.service.list(target);
		assert.equal(page.entries.length, FILE_LIMITS.page);
		assert.ok(page.nextCursor);
		const last = await f.service.list(target, page.nextCursor);
		assert.equal(last.entries.length, 1);
		assert.equal(last.nextCursor, null);
		await writeFile(join(f.rootPath, "new.txt"), "new");
		await assert.rejects(f.service.list(target, page.nextCursor), { code: "VERSION_CONFLICT" });
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("active HTML/SVG is returned only as plain text, with no executable URL or HTML rendering", async () => {
	const f = await fixture();
	try {
		const html = '<script>fetch("https://example.invalid")</script><img src="file:///secret">';
		await writeFile(join(f.rootPath, "hello.txt"), html);
		const preview = await f.service.preview(f.target);
		assert.equal(preview.kind, "text");
		if (preview.kind === "text") {
			assert.equal(preview.rendering, "plain-text-only");
			assert.equal(preview.content.text, html);
		}
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("root discovery is scoped and authority close revokes grants and rejects new work", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(await f.service.listRoots("workspace"), [f.root]);
		await assert.rejects(f.authority.forPrincipal("mallory").listRoots("workspace"), { code: "UNAUTHORIZED" });
		await f.authority.close();
		await f.authority.close();
		await assert.rejects(f.service.listRoots("workspace"), { code: "CLOSED" });
		await assert.rejects(f.service.readText(f.target), { code: "CLOSED" });
	} finally {
		await rm(f.directory, { recursive: true, force: true });
	}
});

test("capacity rejection does not enqueue work; close drains admitted authorization and refuses pending grant", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-file-capacity-"));
	const gate = Promise.withResolvers<void>();
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: () => gate.promise,
	});
	try {
		const pending = Array.from({ length: FILE_LIMITS.concurrent }, () =>
			authority.grantRoot({
				principalId: "alice",
				workspaceId: "workspace",
				absolutePath: directory,
				writable: false,
			}),
		);
		const results = Promise.allSettled(pending);
		await assert.rejects(authority.forPrincipal("alice").listRoots("workspace"), { code: "BUSY" });
		const closing = authority.close();
		gate.resolve();
		await closing;
		for (const result of await results) {
			assert.equal(result.status, "rejected");
			if (result.status === "rejected") assert.equal(result.reason.code, "CLOSED");
		}
	} finally {
		gate.resolve();
		await authority.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the last permission check cannot overwrite an external edit or commit a revoked root", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-file-precommit-"));
	let hook: (() => Promise<void>) | undefined;
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {
			await hook?.();
		},
	});
	try {
		const root = await authority.grantRoot({
			principalId: "alice",
			workspaceId: "workspace",
			absolutePath: directory,
			writable: true,
		});
		const service = authority.forPrincipal("alice");
		const target = { ...root, path: "hello.txt" };
		await writeFile(join(directory, target.path), "original");
		const original = await service.readText(target);
		let calls = 0;
		hook = async () => {
			if (++calls === 2) await writeFile(join(directory, target.path), "external edit");
		};
		await assert.rejects(service.saveText(target, "user buffer", original.revision), { code: "VERSION_CONFLICT" });
		assert.equal(await readFile(join(directory, target.path), "utf8"), "external edit");
		assert.deepEqual(await readdir(directory), ["hello.txt"]);
		hook = undefined;
		const changed = await service.readText(target);
		calls = 0;
		hook = async () => {
			if (++calls === 2) authority.revokeRoot(root.rootId);
		};
		await assert.rejects(service.saveText(target, "user buffer", changed.revision), { code: "UNAUTHORIZED" });
		assert.equal(await readFile(join(directory, target.path), "utf8"), "external edit");
		assert.deepEqual(await readdir(directory), ["hello.txt"]);
	} finally {
		await authority.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("directory and grant quotas reject excess without unbounded listing or hidden truncation", async () => {
	const f = await fixture();
	try {
		for (let i = 0; i <= FILE_LIMITS.directoryEntries; i++) await mkdir(join(f.rootPath, `dir-${i}`));
		await assert.rejects(f.service.list({ ...f.target, path: "" }), { code: "LIMIT_EXCEEDED" });
		for (let i = 1; i < FILE_LIMITS.roots; i++)
			await f.authority.grantRoot({
				principalId: "alice",
				workspaceId: "workspace",
				absolutePath: f.rootPath,
				writable: false,
			});
		await assert.rejects(
			f.authority.grantRoot({
				principalId: "alice",
				workspaceId: "workspace",
				absolutePath: f.rootPath,
				writable: false,
			}),
			{ code: "LIMIT_EXCEEDED" },
		);
		assert.equal((await f.service.listRoots("workspace")).length, FILE_LIMITS.roots);
	} finally {
		await f.authority.close();
		await rm(f.directory, { recursive: true, force: true });
	}
});
