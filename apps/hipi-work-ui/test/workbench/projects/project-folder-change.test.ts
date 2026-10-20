import assert from "node:assert/strict";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { afterEach, beforeEach, test, vi } from "vitest";
import { FileWorkspaceSession } from "../../../src/features/files/file-workspace-session.ts";
import { prepareProjectFolderChange } from "../../../src/features/workbench/projects/folder-change.ts";

let session: FileWorkspaceSession;
beforeEach(() => {
	vi.useFakeTimers();
	const files: FileClient = {
		listRoots: async () => [],
		list: async () => ({ entries: [], nextCursor: null }),
		readText: async () => ({ text: "original", revision: "a".repeat(64), encoding: "utf-8", bytes: 8 }),
		saveText: async () => {
			throw new Error("No save requested");
		},
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
	};
	session = new FileWorkspaceSession(files);
});
afterEach(() => {
	session.dispose();
	vi.useRealTimers();
});
async function open(workspaceId = "project", rootId = "bound-root", path = "file.txt") {
	await session.open({ workspaceId, rootId, path }, true, { pinned: true });
	const tab = session.snapshot().tabs.find((entry) => entry.id === session.snapshot().activeId);
	assert.ok(tab?.kind === "editor");
	return tab;
}
test("reviewing a project disconnect is read-only and Cancel preserves every buffer", async () => {
	const tab = await open();
	tab.editor.edit("keep my draft");
	const decision = prepareProjectFolderChange(session, "project", "bound-root");
	assert.deepEqual(decision.paths, ["file.txt"]);
	assert.equal(decision.unchanged(), true);
	assert.equal(tab.editor.snapshot().document?.text, "keep my draft");
	assert.equal(session.snapshot().tabs.length, 1, "neither review nor a cancelled picker discards files");
});
test("an approved disconnect discards only the reviewed project root", async () => {
	const target = await open();
	target.editor.edit("reviewed");
	const otherProject = await open("other", "bound-root");
	otherProject.editor.edit("unrelated project");
	const otherRoot = await open("project", "manual-root");
	otherRoot.editor.edit("unrelated root");
	const decision = prepareProjectFolderChange(session, "project", "bound-root");
	assert.equal(decision.discardReviewed(), true);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[otherProject.id, otherRoot.id],
	);
	assert.equal(otherProject.editor.snapshot().document?.text, "unrelated project");
	assert.equal(otherRoot.editor.snapshot().document?.text, "unrelated root");
});
test("later edits and reopened same-path files cannot inherit an earlier discard decision", async () => {
	const tab = await open();
	tab.editor.edit("first draft");
	const decision = prepareProjectFolderChange(session, "project", "bound-root");
	tab.editor.edit("later draft");
	assert.equal(decision.unchanged(), false);
	assert.equal(decision.discardReviewed(), false);
	assert.equal(tab.editor.snapshot().document?.text, "later draft");
	session.discard([tab.id]);
	const replacement = await open();
	replacement.editor.edit("new owner");
	assert.equal(decision.discardReviewed(), false);
	assert.equal(replacement.editor.snapshot().document?.text, "new owner");
});
