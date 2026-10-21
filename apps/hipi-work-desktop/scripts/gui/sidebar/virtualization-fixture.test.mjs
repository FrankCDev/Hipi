import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { createGuiProfile } from "../../smoke-packaged-gui.mjs";
import {
	publishVirtualizationProjection,
	seedSidebarVirtualization,
	verifySidebarVirtualization,
} from "./virtualization-fixture.mjs";
import { virtualizationRoleEntry, virtualizationWorkspaceIds } from "./virtualization-manifest.mjs";

test("publication diagnostics distinguish unchanged pass and monotonic time bounds without exposing cursors", async () => {
	for (const timed of [false, true]) {
		let calls = 0;
		await assert.rejects(
			publishVirtualizationProjection(
				{
					async call(method, params) {
						assert.equal(method, "refreshSidebarProjection");
						assert.deepEqual(params, {});
						calls++;
						if (calls === 1) throw Object.assign(Error("stale"), { code: "CURSOR_STALE" });
						return { state: "building", nextCursor: `private-cursor-${calls}` };
					},
				},
				() => (timed && calls >= 3 ? 30000 : 0),
			),
			(error) => {
				assert.doesNotMatch(error.message, /private-cursor/);
				const diagnostics = JSON.parse(error.message.slice(error.message.indexOf("{")));
				assert.deepEqual(diagnostics, {
					passLimitReached: !timed,
					timeLimitReached: timed,
					pass: timed ? 3 : 2404,
					restarts: 1,
					cursorChanges: timed ? 2 : 2403,
					state: "building",
					elapsedMs: timed ? 30000 : 0,
				});
				return true;
			},
		);
	}
});

test("publication still requires ready with no cursor and preserves restart/error bounds", async () => {
	let calls = 0;
	await publishVirtualizationProjection(
		{
			async call() {
				calls++;
				return { state: "ready", nextCursor: calls === 1 ? "private" : null };
			},
		},
		() => 0,
	);
	assert.equal(calls, 2);
	calls = 0;
	const stale = Object.assign(Error("stale"), { code: "CURSOR_STALE" });
	await assert.rejects(
		publishVirtualizationProjection(
			{
				async call() {
					calls++;
					throw stale;
				},
			},
			() => 0,
		),
		(error) => error === stale,
	);
	assert.equal(calls, 15);
	const failure = Error("runtime failure");
	await assert.rejects(
		publishVirtualizationProjection(
			{
				async call() {
					throw failure;
				},
			},
			() => 0,
		),
		(error) => error === failure,
	);
});

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
