import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { createFileClient, parseProjectFolder, parseProjectFolderSelection } from "@hipi/work-runtime/files/protocol";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { FileConnection } from "../src/file-connection.ts";
import { chooseProjectDirectory } from "../src/file-messages.ts";
import { manageFileRoots, ProjectFolderSelections } from "../src/file-picker.ts";
import { rootRequest } from "../src/file-protocol.ts";
import { createFileRuntime } from "../src/file-runtime.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-project-"));
	const folder = join(directory, "project");
	await mkdir(folder);
	await writeFile(join(folder, "note.txt"), "local");
	const runtime = await openTestRuntime(join(directory, "store"));
	const { storeId } = await runtime.call("handshake", {});
	const tasks = new Set<Promise<boolean>>();
	const host = new FileConnection("first", (raw) => {
		const task = files.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => host.close());
	});
	const files = await createFileRuntime(runtime, "first", (raw) => host.receive(raw));
	const selections = new ProjectFolderSelections();
	const base = { version: 1 as const, expectedStoreId: storeId };
	return {
		directory,
		folder,
		runtime,
		host,
		files,
		selections,
		base,
		client: createFileClient({ storeId, request: (request) => host.call({ operation: "request", request }) }),
		manage: (
			operation: object,
			picker: (writable: boolean, project?: boolean, locale?: "en" | "zh-CN") => Promise<string | null> = async () =>
				folder,
		) =>
			manageFileRoots(
				{ ...base, ...operation },
				() => host,
				() => true,
				picker,
				selections,
			),
		async close() {
			selections.clear();
			await Promise.all(tasks);
			host.close();
			await files.close();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("native selection cancellation and forgotten creation drafts never create an orphan project or file grant", async () => {
	const app = await fixture();
	try {
		assert.equal(await app.manage({ operation: "project-prepare" }, async () => null), null);
		assert.deepEqual(await app.runtime.call("listWorkspaces", {}), { items: [], nextCursor: null });
		const selection = parseProjectFolderSelection(
			await app.manage({ operation: "project-prepare" }, async (writable, project) => {
				assert.equal(writable, false);
				assert.equal(project, true);
				return app.folder;
			}),
		);
		assert.equal(selection.displayName, "project");
		assert.equal(JSON.stringify(selection).includes(app.directory), false);
		assert.deepEqual(await app.runtime.call("listWorkspaces", {}), { items: [], nextCursor: null });
		await app.manage({ operation: "project-forget", selectionId: selection.selectionId });
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Intentional project" });
		await assert.rejects(
			app.manage({ operation: "project-attach", workspaceId: "work", selectionId: selection.selectionId }),
			{ code: "UNAUTHORIZED" },
		);
		assert.equal(
			parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work").status,
			"unbound",
		);
		assert.deepEqual(await app.client.listRoots("work"), []);
	} finally {
		await app.close();
	}
});

test("prepared directory attaches once after intentional creation, and replay cannot attach a different project", async () => {
	const app = await fixture();
	try {
		const selection = parseProjectFolderSelection(await app.manage({ operation: "project-prepare" }));
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Project" });
		const folder = parseProjectFolder(
			await app.manage({ operation: "project-attach", workspaceId: "work", selectionId: selection.selectionId }),
			"work",
		);
		assert.equal(folder.status, "available");
		if (folder.status === "available") assert.equal(folder.displayPath, await realpath(app.folder));
		assert.ok(folder.root);
		assert.equal(folder.root.writable, false);
		assert.equal(
			(await app.client.readText({ workspaceId: "work", rootId: folder.root.rootId, path: "note.txt" })).text,
			"local",
		);
		await app.runtime.call("createWorkspace", { workspaceId: "other", name: "Other" });
		await assert.rejects(
			app.manage({ operation: "project-attach", workspaceId: "other", selectionId: selection.selectionId }),
			{ code: "UNAUTHORIZED" },
		);
		// Even a trusted-host replay bypassing the main ownership map cannot reuse a consumed utility token.
		await assert.rejects(
			app.host.call({
				operation: "project-attach",
				expectedStoreId: app.base.expectedStoreId,
				workspaceId: "other",
				selectionId: selection.selectionId,
			}),
			{ code: "UNAUTHORIZED" },
		);
		assert.equal(
			parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "other" }), "other").status,
			"unbound",
		);
	} finally {
		await app.close();
	}
});

test("native picker lifetime and utility generation are checked before publishing prepared selections or bindings", async () => {
	const app = await fixture();
	const replacement = new FileConnection("replacement", () => {});
	try {
		let owned = true;
		await assert.rejects(
			manageFileRoots(
				{ ...app.base, operation: "project-prepare" },
				() => app.host,
				() => owned,
				async () => {
					owned = false;
					return app.folder;
				},
				app.selections,
			),
			{ code: "CLOSED" },
		);
		let connection = app.host;
		await assert.rejects(
			manageFileRoots(
				{ ...app.base, operation: "project-prepare" },
				() => connection,
				() => true,
				async () => {
					connection = replacement;
					return app.folder;
				},
				app.selections,
			),
			{ code: "CLOSED" },
		);
		const selection = parseProjectFolderSelection(await app.manage({ operation: "project-prepare" }));
		app.selections.clear();
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		await assert.rejects(
			app.manage({ operation: "project-attach", workspaceId: "work", selectionId: selection.selectionId }),
			{ code: "UNAUTHORIZED" },
		);
		assert.deepEqual(await app.client.listRoots("work"), []);
		await assert.rejects(app.manage({ operation: "project-pick", workspaceId: "missing", expectedBindingId: null }), {
			code: "UNAUTHORIZED",
		});
	} finally {
		replacement.close();
		await app.close();
	}
});

test("a prepared folder identity cannot be silently replaced before final Create", async () => {
	const app = await fixture();
	try {
		const selection = parseProjectFolderSelection(await app.manage({ operation: "project-prepare" }));
		await rename(app.folder, join(app.directory, "original"));
		await mkdir(app.folder);
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Explicit project" });
		await assert.rejects(
			app.manage({ operation: "project-attach", workspaceId: "work", selectionId: selection.selectionId }),
			{ code: "BLOCKED_RESOURCE" },
		);
		assert.deepEqual((await app.runtime.call("listWorkspaces", {})).items, [
			{ workspaceId: "work", name: "Explicit project" },
		]);
		assert.equal(
			parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work").status,
			"unbound",
		);
		assert.deepEqual(await app.client.listRoots("work"), []);
	} finally {
		await app.close();
	}
});

test("project picker cancellation preserves the current persistent association and stale actions cannot replace or unbind it", async () => {
	const app = await fixture();
	try {
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const first = parseProjectFolder(
			await app.manage({ operation: "project-pick", workspaceId: "work", expectedBindingId: null }),
			"work",
		);
		assert.equal(
			await app.manage(
				{ operation: "project-pick", workspaceId: "work", expectedBindingId: first.bindingId },
				async () => null,
			),
			null,
		);
		assert.deepEqual(
			parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work"),
			first,
		);
		const second = parseProjectFolder(
			await app.manage({ operation: "project-pick", workspaceId: "work", expectedBindingId: first.bindingId }),
			"work",
		);
		await assert.rejects(
			app.manage({ operation: "project-unbind", workspaceId: "work", expectedBindingId: first.bindingId }),
			{ code: "VERSION_CONFLICT" },
		);
		assert.equal(
			parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work").bindingId,
			second.bindingId,
		);
	} finally {
		await app.close();
	}
});

test("revoking a project through the existing file bridge persists across queries and runtime restart", async () => {
	const app = await fixture();
	try {
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const folder = parseProjectFolder(
			await app.manage({ operation: "project-pick", workspaceId: "work", expectedBindingId: null }),
			"work",
		);
		assert.ok(folder.root);
		await app.manage({ operation: "revoke", workspaceId: "work", rootId: folder.root.rootId });
		const revoked = parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work");
		assert.equal(revoked.status, "revoked");
		assert.equal("displayPath" in revoked, false);
		assert.equal(revoked.bindingId, folder.bindingId);
		assert.deepEqual(await app.client.listRoots("work"), []);
		await app.files.close();
		await app.runtime.close();
		const runtime = await openTestRuntime(join(app.directory, "store"));
		const host = new FileConnection("restarted", (raw) => {
			void files.receive(raw).catch(() => host.close());
		});
		const files = await createFileRuntime(runtime, "restarted", (raw) => host.receive(raw));
		try {
			const restored = parseProjectFolder(
				await host.call({ operation: "project-get", expectedStoreId: app.base.expectedStoreId, workspaceId: "work" }),
				"work",
			);
			assert.deepEqual(restored, revoked);
			assert.deepEqual(await files.agentFiles.listRoots("work"), []);
		} finally {
			host.close();
			await files.close();
			await runtime.close();
		}
	} finally {
		await app.close();
	}
});

test("desktop project responses expose the verified current path without changing root or runtime context", async () => {
	const app = await fixture();
	try {
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const unbound = parseProjectFolder(await app.manage({ operation: "project-get", workspaceId: "work" }), "work");
		assert.equal("displayPath" in unbound, false);
		const picked = `${app.folder}${sep}.`;
		const first = parseProjectFolder(
			await app.manage({ operation: "project-pick", workspaceId: "work", expectedBindingId: null }, async () => picked),
			"work",
		);
		assert.equal(first.status, "available");
		if (first.status !== "available") assert.fail("Expected an available binding");
		assert.equal(first.displayPath, await realpath(app.folder));
		assert.notEqual(first.displayPath, picked);
		assert.equal(first.displayName, "project");
		assert.equal("displayPath" in first.root, false);
		assert.equal(JSON.stringify(await app.client.listRoots("work")).includes(app.directory), false);
		assert.equal(
			JSON.stringify(await app.runtime.call("getWorkspace", { workspaceId: "work" })).includes(app.directory),
			false,
		);
		assert.deepEqual(await app.files.agentFiles.listRoots("work"), [first.root]);
		await app.files.close();
		await app.runtime.close();
		const runtime = await openTestRuntime(join(app.directory, "store"));
		const host = new FileConnection("reopened", (raw) => {
			void files.receive(raw).catch(() => host.close());
		});
		const files = await createFileRuntime(runtime, "reopened", (raw) => host.receive(raw));
		try {
			const restored = parseProjectFolder(
				await host.call({ operation: "project-get", expectedStoreId: app.base.expectedStoreId, workspaceId: "work" }),
				"work",
			);
			assert.equal(restored.status, "available");
			if (restored.status !== "available") assert.fail("Expected an available restored binding");
			assert.equal(restored.displayPath, first.displayPath);
			assert.equal(restored.bindingId, first.bindingId);
			assert.equal(restored.revision, first.revision);
			await rename(app.folder, join(app.directory, "moved"));
			const missing = parseProjectFolder(
				await host.call({ operation: "project-get", expectedStoreId: app.base.expectedStoreId, workspaceId: "work" }),
				"work",
			);
			assert.equal(missing.status, "unavailable");
			assert.equal("displayPath" in missing, false);
			assert.equal(missing.bindingId, first.bindingId);
		} finally {
			host.close();
			await files.close();
			await runtime.close();
		}
	} finally {
		await app.close();
	}
});

test("renderer project requests cannot supply paths, identity, permissions, or another principal", () => {
	const base = { version: 1, expectedStoreId: "store" };
	for (const request of [
		{ operation: "project-prepare", absolutePath: "/private" },
		{ operation: "project-prepare", workspaceId: "smuggled" },
		{ operation: "project-attach", workspaceId: "work", selectionId: "selected", writable: true },
		{ operation: "project-pick", workspaceId: "work", expectedBindingId: null, device: "1" },
		{ operation: "project-get", workspaceId: "work", principalId: "other" },
		{ operation: "project-get", workspaceId: "work", displayPath: "~/Project" },
		{ operation: "project-bind", workspaceId: "work", absolutePath: "/private", expectedBindingId: null },
	])
		assert.throws(() => rootRequest({ ...base, ...request }));
	assert.deepEqual(chooseProjectDirectory("en"), { title: "Choose project folder", buttonLabel: "Select" });
	assert.deepEqual(chooseProjectDirectory("zh-CN"), { title: "选择项目文件夹", buttonLabel: "选择" });
	for (const locale of ["en-US", "zh", "fr", "/private", 1, null])
		assert.throws(() => rootRequest({ ...base, operation: "project-prepare", locale }));
});

test("native project picker uses only the bounded current UI locale, defaulting to English", async () => {
	const app = await fixture();
	try {
		await app.runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		for (const locale of [undefined, "en", "zh-CN"] as const) {
			for (const operation of [
				{ operation: "project-prepare" },
				{ operation: "project-pick", workspaceId: "work", expectedBindingId: null },
			]) {
				assert.equal(
					await app.manage({ ...operation, ...(locale ? { locale } : {}) }, async (writable, project, actual) => {
						assert.equal(writable, false);
						assert.equal(project, true);
						assert.equal(actual, locale ?? "en");
						return null;
					}),
					null,
				);
			}
		}
	} finally {
		await app.close();
	}
});

test("utility replacement discards stale prepared-token ownership rather than filling the new generation quota", () => {
	const selections = new ProjectFolderSelections();
	const first = new FileConnection("first", () => {});
	const second = new FileConnection("second", () => {});
	try {
		for (let index = 0; index < 8; index++) selections.add(`old-${index}`, first, "store");
		selections.add("new", second, "store");
		assert.throws(() => selections.take("old-0", second, "store"), { code: "UNAUTHORIZED" });
		selections.take("new", second, "store");
	} finally {
		first.close();
		second.close();
		selections.clear();
	}
});
