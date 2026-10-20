import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "../src/contracts.ts";
import { createRuntimeFileHost } from "../src/files/host.ts";
import { parseFileRoots, parseProjectFolder, parseProjectFolderSelection } from "../src/files/protocol.ts";
import { createRuntimeProjectFolders } from "../src/node.ts";
import { openTestRuntime } from "../src/testing.ts";

async function fixture(options: { includeDisplayPath?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-folder-"));
	const folder = join(directory, "project");
	await mkdir(folder);
	await writeFile(join(folder, "note.txt"), "original");
	const runtime = await openTestRuntime(join(directory, "store"));
	await runtime.call("createWorkspace", { workspaceId: "one", name: "One" });
	await runtime.call("createWorkspace", { workspaceId: "two", name: "Two" });
	const files = await createRuntimeFileHost(runtime, "first");
	const projects = createRuntimeProjectFolders(runtime, files.authority, "first", options);
	assert.ok(projects);
	return {
		directory,
		folder,
		runtime,
		files,
		projects,
		service: files.authority.forPrincipal("first"),
		async close() {
			await projects.close();
			await files.authority.close();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("project association persists but roots, write permissions, and Agent consent do not", async () => {
	const app = await fixture();
	try {
		assert.equal((await app.projects.get("one")).status, "unbound");
		const conversation = await app.runtime.call("createConversation", {
			requestId: "conversation",
			workspaceId: "one",
			title: "No inherited consent",
		});
		const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		const first = await app.projects.bind("one", app.folder, null);
		assert.equal(first.status, "available");
		assert.ok(first.root);
		assert.equal(first.root.writable, false);
		assert.equal(first.displayName, "project");
		assert.equal("displayPath" in first, false);
		assert.equal(JSON.stringify(first).includes(app.directory), false);
		const target = { workspaceId: "one", rootId: first.root.rootId, path: "note.txt" };
		const content = await app.service.readText(target);
		await assert.rejects(app.service.saveText(target, "forbidden", content.revision), { code: "UNAUTHORIZED" });
		assert.equal(await readFile(join(app.folder, "note.txt"), "utf8"), "original");
		assert.deepEqual(await app.runtime.call("listActiveAgentContexts", scope), []);
		await app.projects.close();
		await app.files.authority.close();
		await app.runtime.close();
		const runtime = await openTestRuntime(join(app.directory, "store"));
		const files = await createRuntimeFileHost(runtime, "second");
		const projects = createRuntimeProjectFolders(runtime, files.authority, "second");
		assert.ok(projects);
		try {
			const service = files.authority.forPrincipal("second");
			assert.deepEqual(await service.listRoots("one"), []);
			const restored = await projects.get("one");
			assert.equal(restored.status, "available");
			assert.ok(restored.root);
			assert.equal(restored.bindingId, first.bindingId);
			assert.equal(restored.revision, first.revision);
			assert.equal("displayPath" in restored, false);
			assert.notEqual(restored.root.rootId, first.root.rootId);
			assert.equal(restored.root.writable, false);
			assert.equal((await projects.get("one")).root?.rootId, restored.root.rootId);
			const reads = await Promise.all(Array.from({ length: 12 }, () => projects.get("one")));
			assert.ok(reads.every((folder) => folder.root?.rootId === restored.root.rootId));
			assert.equal((await service.listRoots("one")).length, 1);
			await assert.rejects(service.readText(target), { code: "UNAUTHORIZED" });
			assert.deepEqual(await runtime.call("listActiveAgentContexts", scope), []);
			assert.deepEqual(await runtime.call("listPendingToolApprovals", scope), { items: [], nextCursor: null });
		} finally {
			await projects.close();
			await files.authority.close();
			await runtime.close();
		}
	} finally {
		await app.close();
	}
});

test("replacement and unbind use binding identity fences and revoke old roots without cross-workspace access", async () => {
	const app = await fixture();
	try {
		const first = await app.projects.bind("one", app.folder, null);
		assert.ok(first.root);
		assert.ok(first.bindingId);
		const oldTarget = { workspaceId: "one", rootId: first.root.rootId, path: "note.txt" };
		await assert.rejects(app.service.readText({ ...oldTarget, workspaceId: "two" }), { code: "UNAUTHORIZED" });
		assert.equal((await app.projects.get("two")).status, "unbound");
		await assert.rejects(app.projects.bind("missing", app.folder, null), { code: "UNAUTHORIZED" });
		const replacement = await app.projects.bind("one", app.folder, first.bindingId);
		assert.ok(replacement.bindingId);
		assert.ok(replacement.root);
		assert.notEqual(replacement.bindingId, first.bindingId);
		assert.equal(replacement.revision, 2);
		await assert.rejects(app.service.readText(oldTarget), { code: "UNAUTHORIZED" });
		await assert.rejects(app.projects.bind("one", app.folder, first.bindingId), { code: "VERSION_CONFLICT" });
		await assert.rejects(app.projects.unbind("one", first.bindingId), { code: "VERSION_CONFLICT" });
		assert.equal((await app.projects.get("one")).root?.rootId, replacement.root.rootId);
		const revoked = await app.projects.unbind("one", replacement.bindingId);
		assert.equal(revoked.status, "revoked");
		assert.equal(revoked.revision, 3);
		assert.equal(revoked.bindingId, replacement.bindingId);
		assert.deepEqual(await app.service.listRoots("one"), []);
		assert.deepEqual(await app.projects.get("one"), revoked);
		assert.deepEqual(await app.projects.unbind("one", replacement.bindingId), revoked);
		await app.projects.close();
		await app.files.authority.close();
		await app.runtime.close();
		const runtime = await openTestRuntime(join(app.directory, "store"));
		const files = await createRuntimeFileHost(runtime, "again");
		const projects = createRuntimeProjectFolders(runtime, files.authority, "again");
		assert.ok(projects);
		try {
			assert.deepEqual(await projects.get("one"), revoked);
			assert.deepEqual(await files.authority.forPrincipal("again").listRoots("one"), []);
		} finally {
			await projects.close();
			await files.authority.close();
			await runtime.close();
		}
	} finally {
		await app.close();
	}
});

test("slow real project reopen coalesces concurrent UI reads while mutations remain exclusive", async (context) => {
	const app = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let reopened: ReturnType<typeof createRuntimeProjectFolders>;
	try {
		const bound = await app.projects.bind("one", app.folder, null);
		assert.ok(bound.bindingId);
		await app.projects.close();
		const grant = app.files.authority.grantRoot.bind(app.files.authority);
		const granting = context.mock.method(
			app.files.authority,
			"grantRoot",
			async (input: Parameters<typeof grant>[0]) => {
				entered.resolve();
				await release.promise;
				return grant(input);
			},
		);
		reopened = createRuntimeProjectFolders(app.runtime, app.files.authority, "first");
		assert.ok(reopened);
		const sharedProjectQuery = reopened.get("one");
		await entered.promise;
		const filePanelRead = reopened.get("one");
		const contextDialogRead = reopened.get("one");
		assert.equal(filePanelRead, sharedProjectQuery);
		assert.equal(contextDialogRead, sharedProjectQuery);
		const rootLists = [filePanelRead, contextDialogRead].map(async (read) => {
			await read;
			return app.service.listRoots("one");
		});
		await assert.rejects(reopened.unbind("one", bound.bindingId), { code: "BUSY" });
		assert.deepEqual(await app.service.listRoots("one"), []);
		release.resolve();
		const opened = await sharedProjectQuery;
		assert.equal(opened.status, "available");
		assert.ok(opened.root);
		assert.equal(granting.mock.callCount(), 1);
		for (const roots of await Promise.all(rootLists)) assert.deepEqual(roots, [opened.root]);
		assert.equal((await reopened.get("one")).root?.rootId, opened.root.rootId);
		assert.deepEqual(await app.service.listRoots("two"), []);
	} finally {
		release.resolve();
		await reopened?.close();
		await app.close();
	}
});

test("missing, replaced and symlinked directories fail closed without silently changing the bound identity", async () => {
	const app = await fixture();
	try {
		const first = await app.projects.bind("one", app.folder, null);
		assert.ok(first.root);
		await rename(app.folder, join(app.directory, "moved"));
		const absent = await app.projects.get("one");
		assert.equal(absent.status, "unavailable");
		assert.equal(absent.bindingId, first.bindingId);
		assert.deepEqual(await app.service.listRoots("one"), []);
		await mkdir(app.folder);
		assert.equal((await app.projects.get("one")).status, "moved");
		await rm(app.folder, { recursive: true });
		await symlink(join(app.directory, "moved"), app.folder, "dir");
		assert.equal((await app.projects.get("one")).status, "moved");
		await assert.rejects(app.projects.bind("two", app.folder, null), { code: "BLOCKED_RESOURCE" });
		assert.equal((await app.projects.get("two")).status, "unbound");
		await rm(app.folder);
		await rename(join(app.directory, "moved"), app.folder);
		const returned = await app.projects.get("one");
		assert.equal(returned.status, "available");
		assert.ok(returned.root);
		assert.notEqual(returned.root.rootId, first.root.rootId);
		assert.equal(returned.bindingId, first.bindingId);
	} finally {
		await app.close();
	}
});

test("manual revocation of the project root persists instead of being resurrected by a later query", async () => {
	const app = await fixture();
	try {
		const folder = await app.projects.bind("one", app.folder, null);
		assert.ok(folder.root);
		assert.equal(app.projects.revokeRoot("two", folder.root.rootId), false);
		assert.equal(app.projects.revokeRoot("one", folder.root.rootId), true);
		assert.equal((await app.projects.get("one")).status, "revoked");
		await app.projects.close();
		await assert.rejects(app.projects.get("one"), { code: "CLOSED" });
	} finally {
		await app.close();
	}
});

test("an unexpectedly missing cached root is revoked persistently rather than silently regranted", async () => {
	const app = await fixture();
	try {
		const folder = await app.projects.bind("one", app.folder, null);
		assert.ok(folder.root);
		app.files.authority.revokeRoot(folder.root.rootId);
		const state = await app.projects.get("one");
		assert.equal(state.status, "revoked");
		assert.equal(state.bindingId, folder.bindingId);
		assert.deepEqual(await app.projects.get("one"), state);
		assert.deepEqual(await app.service.listRoots("one"), []);
	} finally {
		await app.close();
	}
});

test("native prepared selections expire, are bounded, and cannot attach after their authority closes", async (context) => {
	const app = await fixture();
	let now = Date.now();
	context.mock.method(Date, "now", () => now);
	try {
		const selected: string[] = [];
		for (let index = 0; index < 8; index++) selected.push((await app.projects.prepare(app.folder)).selectionId);
		assert.equal(selected.length, 8);
		await assert.rejects(app.projects.prepare(app.folder), { code: "LIMIT_EXCEEDED" });
		now += 15 * 60_000 + 1;
		const expired = selected[0];
		assert.ok(expired);
		await assert.rejects(app.projects.attach("one", expired), { code: "UNAUTHORIZED" });
		const fresh = await app.projects.prepare(app.folder);
		await app.projects.close();
		await assert.rejects(app.projects.attach("one", fresh.selectionId), { code: "CLOSED" });
		assert.deepEqual(await app.service.listRoots("one"), []);
	} finally {
		await app.close();
	}
});

test("AppClient has no absolute-path project command and public DTO rejects authority paths or writable project roots", async () => {
	const app = await fixture();
	try {
		await assert.rejects(
			app.runtime.execute({
				version: PROTOCOL_VERSION,
				method: "bindProjectFolder",
				params: { workspaceId: "one", absolutePath: app.folder },
			}),
			{ code: "INVALID_REQUEST" },
		);
		const folder = await app.projects.bind("one", app.folder, null);
		assert.ok(folder.root);
		assert.throws(() => parseProjectFolder({ ...folder, canonicalPath: app.folder }, "one"));
		assert.throws(() => parseProjectFolder(folder, "two"));
		assert.throws(() => parseProjectFolder({ ...folder, displayName: app.folder }, "one"));
		assert.throws(() => parseProjectFolder({ ...folder, root: { ...folder.root, writable: true } }, "one"));
		assert.equal(createRuntimeProjectFolders({}, app.files.authority, "first"), undefined);
	} finally {
		await app.close();
	}
});

test("project display paths are bounded host-only labels, not root or selection metadata", () => {
	const root = { workspaceId: "one", rootId: "root", writable: false, displayName: "Project" };
	const folder = {
		workspaceId: "one",
		status: "available",
		bindingId: "binding",
		revision: 1,
		displayName: "Project",
		root,
	};
	for (const displayPath of [
		"/",
		"/home/user/中文 Project",
		"~",
		"~/Projects/Project",
		"~\\Projects\\Project",
		"C:\\Users\\user\\Project",
		"C:/Users/user/Project",
		"\\\\server\\share\\Project",
		`/${"a".repeat(4095)}`,
	]) {
		const parsed = parseProjectFolder({ ...folder, displayPath }, "one");
		assert.equal(parsed.status, "available");
		if (parsed.status === "available") assert.equal(parsed.displayPath, displayPath);
	}
	for (const displayPath of [
		"",
		null,
		1,
		"relative/Project",
		"file:///private/Project",
		"C:relative",
		"~another/Project",
		"\\\\server",
		`/${"a".repeat(4096)}`,
		"/private/\u0000Project",
		"/private/\nProject",
		"/private/\u007fProject",
		"/private/\u202eProject",
		"/private/\ud800Project",
		"/private/\u2028Project",
		"/private/\u2029Project",
	])
		assert.throws(() => parseProjectFolder({ ...folder, displayPath }, "one"), { code: "INVALID_PATH" });
	for (const status of ["unavailable", "moved", "revoked"])
		assert.throws(() => parseProjectFolder({ ...folder, status, root: null, displayPath: "/private" }, "one"));
	assert.throws(() =>
		parseProjectFolder(
			{
				workspaceId: "one",
				status: "unbound",
				bindingId: null,
				revision: 0,
				displayName: null,
				root: null,
				displayPath: "/",
			},
			"one",
		),
	);
	assert.throws(() => parseProjectFolder({ ...folder, displayPath: "/private" }, "two"));
	assert.throws(() => parseFileRoots([{ ...root, displayPath: "/private" }], "one"));
	assert.throws(() =>
		parseProjectFolderSelection({ selectionId: "selection", displayName: "Project", displayPath: "/" }),
	);
});

test("opt-in paths follow verified bindings and disappear when their identity is no longer available", async () => {
	const app = await fixture({ includeDisplayPath: true });
	try {
		const unbound = await app.projects.get("one");
		assert.equal("displayPath" in unbound, false);
		const selected = await app.projects.prepare(app.folder);
		assert.equal("displayPath" in selected, false);
		const bound = await app.projects.attach("one", selected.selectionId);
		assert.equal(bound.status, "available");
		if (bound.status !== "available") assert.fail("Expected an available binding");
		assert.equal(bound.displayPath, await realpath(app.folder));
		assert.equal("displayPath" in bound.root, false);
		assert.equal(JSON.stringify(await app.service.listRoots("one")).includes(app.directory), false);
		const otherFolder = join(app.directory, "replacement");
		await mkdir(otherFolder);
		const replacement = await app.projects.bind("one", otherFolder, bound.bindingId);
		assert.equal(replacement.status, "available");
		if (replacement.status !== "available") assert.fail("Expected an available replacement");
		assert.notEqual(replacement.bindingId, bound.bindingId);
		assert.equal(replacement.revision, bound.revision + 1);
		assert.equal(replacement.displayPath, await realpath(otherFolder));
		await assert.rejects(app.projects.bind("one", app.folder, bound.bindingId), { code: "VERSION_CONFLICT" });
		assert.deepEqual(await app.projects.get("one"), replacement);
		await rename(otherFolder, join(app.directory, "moved"));
		const unavailable = await app.projects.get("one");
		assert.equal(unavailable.status, "unavailable");
		assert.equal(unavailable.bindingId, replacement.bindingId);
		assert.equal("displayPath" in unavailable, false);
		await mkdir(otherFolder);
		const moved = await app.projects.get("one");
		assert.equal(moved.status, "moved");
		assert.equal("displayPath" in moved, false);
		const revoked = await app.projects.unbind("one", replacement.bindingId);
		assert.equal(revoked.status, "revoked");
		assert.equal("displayPath" in revoked, false);
	} finally {
		await app.close();
	}
});

test("host display paths abbreviate only the exact current home boundary and omit unsafe ancestor labels", async () => {
	const app = await fixture();
	const variable = process.platform === "win32" ? "USERPROFILE" : "HOME";
	const previousHome = process.env[variable];
	let projects: ReturnType<typeof createRuntimeProjectFolders>;
	try {
		await app.projects.close();
		process.env[variable] = await realpath(app.directory);
		projects = createRuntimeProjectFolders(app.runtime, app.files.authority, "first", { includeDisplayPath: true });
		assert.ok(projects);
		const bound = await projects.bind("one", app.folder, null);
		assert.equal(bound.status, "available");
		if (bound.status !== "available") assert.fail("Expected an available binding");
		assert.equal(bound.displayPath, `~${sep}project`);
		const home = await projects.bind("two", app.directory, null);
		assert.equal(home.status, "available");
		if (home.status !== "available") assert.fail("Expected an available home binding");
		assert.equal(home.displayPath, "~");
		await projects.close();
		process.env[variable] = (await realpath(app.directory)).slice(0, -1);
		projects = createRuntimeProjectFolders(app.runtime, app.files.authority, "first", { includeDisplayPath: true });
		assert.ok(projects);
		const exact = await projects.get("one");
		assert.equal(exact.status, "available");
		if (exact.status !== "available") assert.fail("Expected an available binding");
		assert.equal(exact.displayPath, await realpath(app.folder));
		if (process.platform !== "win32") {
			const unsafe = join(app.directory, "hidden\nancestor", "safe-basename");
			await mkdir(unsafe, { recursive: true });
			const hidden = await projects.bind("one", unsafe, bound.bindingId);
			assert.equal(hidden.status, "available");
			assert.equal(hidden.displayName, "safe-basename");
			assert.equal("displayPath" in hidden, false);
		}
	} finally {
		if (previousHome === undefined) delete process.env[variable];
		else process.env[variable] = previousHome;
		await projects?.close();
		await app.close();
	}
});

test("a missing project directory is not silently rebuilt as an empty binding catalog", async () => {
	const app = await fixture();
	try {
		await app.projects.bind("one", app.folder, null);
		await app.projects.close();
		await app.files.authority.close();
		await app.runtime.close();
		const database = new DatabaseSync(join(app.directory, "store", "catalog.sqlite"));
		try {
			database.exec("DROP TABLE project_folders");
		} finally {
			database.close();
		}
		await assert.rejects(openTestRuntime(join(app.directory, "store")), { code: "STORE_MISMATCH" });
		const inspected = new DatabaseSync(join(app.directory, "store", "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(inspected.prepare("SELECT version FROM identity").get()?.version, 8);
			assert.equal(inspected.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_folders'").get(), undefined);
		} finally {
			inspected.close();
		}
	} finally {
		await app.close();
	}
});
