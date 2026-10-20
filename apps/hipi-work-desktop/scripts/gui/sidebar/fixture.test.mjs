import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { assertScenarioWorkspaceDatabases, createGuiProfile } from "../../smoke-packaged-gui.mjs";
import { seedSidebar, verifySidebar } from "./fixture.mjs";
import { defaultRoleEntry } from "./manifest.mjs";

test("public-runtime sidebar fixture persists three exact workspaces, cross-project pins and bounded history", async () => {
	const ownedProfileRoot = await createGuiProfile();
	let closedChecks = 0;
	const context = {
		ownedProfileRoot,
		assertAllOwnedProcessesExited: async () => {
			closedChecks++;
		},
	};
	try {
		const seed = await seedSidebar(context);
		assert.equal(closedChecks, 1);
		assert.equal(seed.snapshot.workspaces.length, 3);
		assert.equal(seed.snapshot.conversations.length, 28);
		assert.equal(seed.pins.length, 3);
		assert.equal(seed.aliasProjectId, "sidebar-project-a");
		assert.equal(new Set(seed.pins.map((scope) => scope.workspaceId)).size, 2);
		assert.equal(
			seed.snapshot.conversations.reduce((count, item) => count + item.history.messages.length, 0),
			2,
		);
		assert.deepEqual(JSON.parse(defaultRoleEntry(seed).value), {
			version: 1,
			role: "default-chat-workspace",
			workspaceId: seed.defaultWorkspaceId,
		});
		assert.ok(
			seed.snapshot.conversations.some(
				({ conversation }) =>
					conversation.workspaceId === seed.alias.workspaceId &&
					conversation.conversationId === seed.alias.conversationId,
			),
		);
		assert.ok(
			!seed.pins.some(
				(scope) => scope.workspaceId === seed.alias.workspaceId && scope.conversationId === seed.alias.conversationId,
			),
		);
		await assertScenarioWorkspaceDatabases(await ownedHistoryDirectory(ownedProfileRoot), "sidebar");
		const result = await verifySidebar({ ...context, seed, gui: { final: { pins: seed.snapshot.pins } } });
		assert.equal(result.cleanColdRead, true);
		assert.equal(closedChecks, 2);
		await assert.rejects(seedSidebar(context), /deep-equal/);
		await assert.rejects(verifySidebar({ ...context, seed, gui: { final: { pins: [] } } }), /Cold runtime order/);
	} finally {
		await rm(ownedProfileRoot, { recursive: true, force: true });
	}
});

test("sidebar fixture never opens a profile before native-process closure is confirmed", async () => {
	for (const operation of [seedSidebar, verifySidebar])
		await assert.rejects(
			operation({
				ownedProfileRoot: "/must-not-be-read",
				assertAllOwnedProcessesExited() {
					throw new Error("Owned native process still running");
				},
			}),
			/Owned native process still running/,
		);
});
