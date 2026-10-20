import assert from "node:assert/strict";
import { test } from "node:test";
import { FileServiceError } from "@hipi/work-runtime/files";
import { type DesktopFileBridge, desktopFiles } from "../src/app/file-client.ts";

test("desktop authority is scoped to verified store and explicit read/write picker", async () => {
	const requests: unknown[] = [];
	const bridge: DesktopFileBridge = {
		request: async () => {
			throw Error("unused");
		},
		manage: async (request) => {
			requests.push(request);
			return { ok: true, result: null };
		},
	};
	const ports = desktopFiles(bridge, "store");
	await ports.fileAuthority.chooseRoot("workspace");
	await ports.fileAuthority.revokeRoot("workspace", "root");
	assert.deepEqual(requests, [
		{ version: 1, expectedStoreId: "store", workspaceId: "workspace", operation: "pick", writable: true },
		{ version: 1, expectedStoreId: "store", workspaceId: "workspace", operation: "revoke", rootId: "root" },
	]);
});
test("malformed and cross-workspace picker results fail closed", async () => {
	for (const result of [
		{ ok: false, error: "UNAUTHORIZED" },
		{ ok: true },
		{ ok: true, result: { workspaceId: "other", rootId: "root", writable: true } },
	]) {
		const ports = desktopFiles({ request: async () => null, manage: async () => result }, "store");
		await assert.rejects(() => ports.fileAuthority.chooseRoot("workspace"), FileServiceError);
	}
});
test("desktop file transport validates response store and preserves unknown write semantics", async () => {
	const ports = desktopFiles(
		{
			request: async () => ({
				version: 1,
				storeId: "other",
				method: "saveText",
				target: { workspaceId: "workspace", rootId: "root", path: "file" },
				ok: true,
				result: { text: "text", bytes: 4, revision: "b".repeat(64), encoding: "utf-8" },
			}),
			manage: async () => null,
		},
		"store",
	);
	await assert.rejects(
		() => ports.files.saveText({ workspaceId: "workspace", rootId: "root", path: "file" }, "text", "a".repeat(64)),
		(error: unknown) => error instanceof FileServiceError && error.code === "WRITE_OUTCOME_UNKNOWN",
	);
});
test("pre-creation folder selection transports only a scoped opaque token and cancellation stays null", async () => {
	const requests: unknown[] = [];
	let result: unknown = null;
	const ports = desktopFiles(
		{
			request: async () => null,
			manage: async (request) => {
				requests.push(request);
				return { ok: true, result };
			},
		},
		"store",
	);
	assert.equal(await ports.fileAuthority.prepareProject?.(), null);
	result = { selectionId: "selection", displayName: "My project" };
	assert.deepEqual(await ports.fileAuthority.prepareProject?.(), result);
	result = {
		workspaceId: "project",
		status: "available",
		bindingId: "binding",
		revision: 1,
		displayName: "My project",
		root: { workspaceId: "project", rootId: "root", writable: false, displayName: "My project" },
	};
	await ports.fileAuthority.attachProject?.("project", "selection");
	assert.deepEqual(requests, [
		{ version: 1, expectedStoreId: "store", operation: "project-prepare" },
		{ version: 1, expectedStoreId: "store", operation: "project-prepare" },
		{
			version: 1,
			expectedStoreId: "store",
			workspaceId: "project",
			operation: "project-attach",
			selectionId: "selection",
		},
	]);
	assert.ok(!JSON.stringify(requests).includes("absolutePath"));
});
test("project bridge rejects widened or cross-project responses and never accepts host path disclosure", async () => {
	const available = {
		workspaceId: "project",
		status: "available",
		bindingId: "binding",
		revision: 1,
		displayName: "My project",
		root: { workspaceId: "project", rootId: "root", writable: false },
	};
	for (const result of [
		{ ...available, workspaceId: "other" },
		{ ...available, root: { ...available.root, workspaceId: "other" } },
		{ ...available, root: { ...available.root, writable: true } },
		{ ...available, absolutePath: "/private/secret-project" },
	]) {
		const ports = desktopFiles({ request: async () => null, manage: async () => ({ ok: true, result }) }, "store");
		await assert.rejects(() => ports.fileAuthority.getProject?.("project") as Promise<unknown>, FileServiceError);
	}
	const ports = desktopFiles(
		{
			request: async () => null,
			manage: async () => ({
				ok: true,
				result: { selectionId: "selection", displayName: "Files", absolutePath: "/secret" },
			}),
		},
		"store",
	);
	await assert.rejects(() => ports.fileAuthority.prepareProject?.() as Promise<unknown>, FileServiceError);
});
