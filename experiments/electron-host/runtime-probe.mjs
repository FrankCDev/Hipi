import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { probeSqlite } from "./sqlite-probe.mjs";

export async function probeRuntime() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-electron-runtime-"));
	try {
		const runtime = await openTestRuntime(directory);
		try {
			const workspace = await runtime.call("createWorkspace", { workspaceId: "probe", name: "Electron compatibility probe" });
			assert.equal(workspace.workspaceId, "probe");
			const conversation = await runtime.call("createConversation", { workspaceId: "probe", title: "Compatibility" });
			const snapshot = await runtime.call("snapshot", { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId });
			assert.equal(snapshot.conversationId, conversation.conversationId);
			return { ...probeSqlite(), kind: "runtime-result", workspace: workspace.workspaceId };
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
