import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { createGuiProfile } from "../../smoke-packaged-gui.mjs";
import { seedSidebarVirtualization, verifySidebarVirtualization } from "./virtualization-fixture.mjs";
import { virtualizationRoleEntry, virtualizationWorkspaceIds } from "./virtualization-manifest.mjs";

test("large fixture uses public deterministic runtime, persists 600 Recent scopes and no submitted turn", async () => {
	const ownedProfileRoot = await createGuiProfile();
	let closures = 0;
	const context = {
		ownedProfileRoot,
		assertAllOwnedProcessesExited: async () => {
			closures++;
		},
	};
	try {
		const seed = await seedSidebarVirtualization(context);
		assert.equal(seed.recent.length, 600);
		assert.equal(seed.snapshot.conversations.length, 601);
		assert.equal(seed.snapshot.workspaces.length, 7);
		assert.equal(seed.snapshot.pins.length, 1);
		assert.deepEqual(
			seed.snapshot.workspaces.map((row) => row.workspaceId),
			[...virtualizationWorkspaceIds],
		);
		for (const [index, workspaceId] of virtualizationWorkspaceIds.entries())
			assert.equal(
				seed.snapshot.conversations.filter((row) => row.workspaceId === workspaceId).length,
				index < 6 ? 100 : 1,
			);
		assert.deepEqual(virtualizationRoleEntry(seed), {
			version: 1,
			storeId: seed.handshake.storeId,
			kind: "value",
			key: "default-chat-workspace",
			value: JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: virtualizationWorkspaceIds[0] }),
		});
		assert.throws(() => virtualizationRoleEntry({ ...seed, workspaceIds: seed.workspaceIds.slice(1) }));
		assert.throws(() => virtualizationRoleEntry({ ...seed, defaultWorkspaceId: "wrong" }));
		assert.throws(() => virtualizationRoleEntry({ ...seed, handshake: { storeId: "../wrong" } }));
		assert.equal(new Set(seed.recent.map((row) => JSON.stringify([row.workspaceId, row.conversationId]))).size, 600);
		assert.ok(!seed.recent.some((row) => row.conversationId === seed.active.conversationId));
		assert.deepEqual(await verifySidebarVirtualization({ ...context, seed }), {
			coldCatalogUnchanged: true,
			conversations: 601,
			submittedTurns: 0,
		});
		assert.equal(closures, 2);
		await assert.rejects(verifySidebarVirtualization({ ...context, seed, gui: {} }), /logical project adoption/);
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(fauxProvider().provider);
		const runtime = await openRuntime(await ownedHistoryDirectory(ownedProfileRoot), {
			models,
			model: { provider: "faux", modelId: "faux-1" },
		});
		try {
			const catalog = await runtime.call("getProjectCatalogState", {});
			await runtime.call("adoptLegacyDefaultWorkspace", {
				requestId: "test-native-startup-adoption-contract",
				workspaceId: seed.defaultWorkspaceId,
				expectedCatalogGeneration: catalog.generation,
				expectedDefaultWorkspaceId: catalog.defaultWorkspaceId,
				provenance: {
					storeId: seed.handshake.storeId,
					markerVersion: 1,
					role: "default-chat-workspace",
					workspaceId: seed.defaultWorkspaceId,
				},
			});
		} finally {
			await runtime.close();
		}
		assert.equal((await verifySidebarVirtualization({ ...context, seed, gui: {} })).coldCatalogUnchanged, true);
		await assert.rejects(seedSidebarVirtualization(context), /nonempty/);
	} finally {
		await rm(ownedProfileRoot, { recursive: true, force: true });
	}
});

test("large fixture never opens the profile before native-process closure is confirmed", async () => {
	for (const operation of [seedSidebarVirtualization, verifySidebarVirtualization])
		await assert.rejects(
			operation({
				ownedProfileRoot: "/not-owned",
				assertAllOwnedProcessesExited() {
					throw Error("Native process still running");
				},
			}),
			/Native process still running/,
		);
});
