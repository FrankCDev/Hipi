import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRuntime } from "../src/node.ts";
import { PiWorkspace } from "../src/pi-workspace.ts";
import { deterministicModels } from "../src/testing.ts";

test("node forwards idle proof and disables startup resume after cache eviction", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-node-cache-"));
	const opened: { workspaceId: string; resume: boolean | undefined }[] = [];
	const original = PiWorkspace.open;
	t.mock.method(PiWorkspace, "open", async (...args: Parameters<typeof PiWorkspace.open>) => {
		opened.push({ workspaceId: args[1].workspaceId, resume: args[1].resume });
		return original(...args);
	});
	const runtime = await openRuntime(directory, {
		models: deterministicModels(),
		model: { provider: "faux", modelId: "faux-1" },
		resume: true,
	});
	let conversationId = "";
	try {
		for (let index = 0; index < 16; index++) {
			await runtime.call("createWorkspace", { workspaceId: `workspace-${index}`, name: `Workspace ${index}` });
			if (index === 1)
				conversationId = (
					await runtime.call("createConversation", {
						workspaceId: "workspace-1",
						requestId: "create",
						title: "Conversation",
					})
				).conversationId;
		}
		assert.equal(opened.length, 16);
		assert.ok(opened.every((item) => item.resume === true));
		// Seventeenth opening succeeds only if node exposes PiWorkspace's real idle proof.
		await runtime.call("createWorkspace", { workspaceId: "workspace-16", name: "Workspace 16" });
		assert.deepEqual(opened.at(-1), { workspaceId: "workspace-16", resume: false });
		await runtime.call("openWorkspace", { workspaceId: "workspace-0" });
		assert.deepEqual(opened.at(-1), { workspaceId: "workspace-0", resume: false });
		assert.equal(opened.filter((item) => item.workspaceId === "workspace-0").length, 2);
		// Precise directory/command reads must not reopen an evicted workspace at all.
		const before = opened.length;
		await runtime.call("getWorkspace", { workspaceId: "workspace-1" });
		assert.equal(
			await runtime.call("getConversationCommandResult", { workspaceId: "workspace-1", requestId: "missing" }),
			null,
		);
		assert.equal(
			await runtime.call("getAgentCommandResult", {
				workspaceId: "workspace-1",
				conversationId,
				requestId: "missing",
			}),
			null,
		);
		assert.equal(opened.length, before);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
