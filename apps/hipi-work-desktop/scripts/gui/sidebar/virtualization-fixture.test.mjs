import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { fixtureProgress, ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { createGuiProfile } from "../../smoke-packaged-gui.mjs";
import {
	publishVirtualizationProjection,
	seedSidebarVirtualization,
	verifySidebarVirtualization,
} from "./virtualization-fixture.mjs";
import { virtualizationRoleEntry, virtualizationWorkspaceIds } from "./virtualization-manifest.mjs";

test("publication diagnostics distinguish fixed 90s time and unchanged pass bounds without exposing cursors", async () => {
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
				() => (timed && calls >= 3 ? 90000 : 0),
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
					elapsedMs: timed ? 90000 : 0,
				});
				return true;
			},
		);
	}
});

test("publication progress never restarts the fixed completion clock", async () => {
	let calls = 0;
	await assert.rejects(
		publishVirtualizationProjection(
			{
				async call() {
					calls++;
					return { state: "building", nextCursor: `cursor-${calls}` };
				},
			},
			() => calls * 30000,
		),
		/"timeLimitReached":true,"pass":3/,
	);
	assert.equal(calls, 3);
});

test("publication rejects a ready result returned at or after the fixed deadline", async () => {
	for (const completion of [89999, 90000, 90001]) {
		let elapsed = 0;
		const result = publishVirtualizationProjection(
			{
				async call() {
					elapsed = completion;
					return { state: "ready", nextCursor: null };
				},
			},
			() => elapsed,
		);
		if (completion < 90000) await result;
		else await assert.rejects(result, /"timeLimitReached":true,"pass":1/);
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

test("large fixture uses public deterministic runtime, persists 600 Recent scopes and no submitted turn", async (t) => {
	const samples = [];
	const progress = fixtureProgress((sample) => t.diagnostic(JSON.stringify(sample)));
	progress("virtual-test-start");
	const ownedProfileRoot = await createGuiProfile();
	let closures = 0;
	const context = {
		reportProgress: (sample) => {
			samples.push(sample);
			t.diagnostic(JSON.stringify(sample));
		},
		ownedProfileRoot,
		assertAllOwnedProcessesExited: async () => {
			closures++;
		},
	};
	try {
		const seed = await seedSidebarVirtualization(context);
		progress("virtual-test-seed-returned", seed.recent.length);
		assert.deepEqual(
			samples.filter(({ stage }) => stage === "virtual-seeded-rows").map(({ count }) => count),
			[100, 200, 300, 400, 500, 600],
		);
		assert.ok(samples.some(({ stage }) => stage === "virtual-projection-ready"));
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
		progress("virtual-test-first-verification");
		await assert.rejects(verifySidebarVirtualization({ ...context, seed, gui: {} }), /logical project adoption/);
		progress("virtual-test-rejected-unadopted");
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
		progress("virtual-test-adoption-shutdown");
		assert.equal((await verifySidebarVirtualization({ ...context, seed, gui: {} })).coldCatalogUnchanged, true);
		progress("virtual-test-adopted-verification");
		await assert.rejects(seedSidebarVirtualization(context), /nonempty/);
		for (const sample of samples) {
			assert.deepEqual(Object.keys(sample), ["stage", "count", "elapsedMs", "intervalMs"]);
			assert.match(sample.stage, /^[a-z-]+$/);
			for (const key of ["count", "elapsedMs", "intervalMs"])
				assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
		}
	} finally {
		await rm(ownedProfileRoot, { recursive: true, force: true });
		progress("virtual-test-cleaned");
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
