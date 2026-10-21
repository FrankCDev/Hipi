// Source-only, independent large fixture. Creates empty conversations without submitting turns.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { fixtureProgress, ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { virtualizationWorkspaceIds } from "./virtualization-manifest.mjs";

export const virtualizationFixture = Object.freeze({
	workspaceIds: virtualizationWorkspaceIds,
	defaultWorkspaceId: virtualizationWorkspaceIds[0],
	recentRows: 600,
	draft: "VIRTUAL_RECENT_UNSUBMITTED 中文",
});
function runtimeOptions() {
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(fauxProvider().provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

// Fixed CI fixture completion tolerance, not a production performance qualification.
// Windows run 39 advanced 332 cursors without a restart in 30 s; never extend this bound on progress.
export async function publishVirtualizationProjection(runtime, now = () => performance.now()) {
	const startedAt = now();
	let restarts = 0,
		cursorChanges = 0,
		previousCursor,
		state = "unobserved";
	for (let pass = 0; ; pass++) {
		const elapsedMs = now() - startedAt;
		const passLimitReached = pass >= 4 * (virtualizationFixture.recentRows + 1);
		const timeLimitReached = elapsedMs >= 90000;
		assert.ok(
			!passLimitReached && !timeLimitReached,
			`Projection publication exceeded fixture bound ${JSON.stringify({ passLimitReached, timeLimitReached, pass, restarts, cursorChanges, state, elapsedMs: Math.round(elapsedMs) })}`,
		);
		let coverage;
		try {
			coverage = await runtime.call("refreshSidebarProjection", {});
		} catch (error) {
			if (error.code !== "CURSOR_STALE" || ++restarts > virtualizationWorkspaceIds.length * 2) throw error;
			continue;
		}
		state = ["building", "refreshing", "ready"].includes(coverage.state) ? coverage.state : "unknown";
		if (coverage.nextCursor !== previousCursor) cursorChanges++;
		previousCursor = coverage.nextCursor;
		if (coverage.state === "ready" && !coverage.nextCursor) {
			// Reject late completion too. This does not cancel a blocked call; the outer test owns that bound.
			const completedElapsedMs = now() - startedAt;
			assert.ok(
				completedElapsedMs < 90000,
				`Projection publication exceeded fixture bound ${JSON.stringify({ passLimitReached: false, timeLimitReached: true, pass: pass + 1, restarts, cursorChanges, state, elapsedMs: Math.round(completedElapsedMs) })}`,
			);
			return;
		}
	}
}

export async function virtualizationSnapshot(runtime) {
	const workspaces = await runtime.call("listWorkspaces", {});
	assert.equal(workspaces.nextCursor, null);
	const conversations = [];
	for (const { workspaceId } of workspaces.items) {
		let cursor;
		for (let pageNumber = 0; ; pageNumber++) {
			assert.ok(pageNumber < 20, "Large fixture catalog traversal exceeded its bound");
			const page = await runtime.call("listConversations", {
				workspaceId,
				filter: "all",
				...(cursor ? { cursor } : {}),
			});
			conversations.push(...page.items);
			if (!page.nextCursor) break;
			assert.notEqual(page.nextCursor, cursor, "Catalog cursor cannot stall");
			cursor = page.nextCursor;
		}
	}
	assert.equal(
		new Set(conversations.map((row) => JSON.stringify([row.workspaceId, row.conversationId]))).size,
		conversations.length,
	);
	const pins = await runtime.call("listPinnedConversations", {});
	assert.equal(pins.nextCursor, null);
	return {
		workspaces: workspaces.items.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
		conversations: conversations.sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
		pins: pins.items,
	};
}

export async function seedSidebarVirtualization({ ownedProfileRoot, assertAllOwnedProcessesExited, reportProgress }) {
	const progress = fixtureProgress(reportProgress);
	progress("virtual-seed-start");
	await assertAllOwnedProcessesExited();
	const directory = await ownedHistoryDirectory(ownedProfileRoot);
	assert.deepEqual(await readdir(directory), [], "Never seed a nonempty profile");
	let runtime = await openRuntime(directory, runtimeOptions());
	try {
		progress("virtual-seed-open");
		for (const [index, workspaceId] of virtualizationWorkspaceIds.entries())
			await runtime.call("createWorkspace", { workspaceId, name: index === 0 ? "Chats" : `Virtual project ${index}` });
		const active = await runtime.call("createConversation", {
			workspaceId: virtualizationWorkspaceIds[6],
			requestId: "virtual-active",
			title: "Active empty control conversation",
		});
		const scope = { workspaceId: active.workspaceId, conversationId: active.conversationId };
		await runtime.call("setConversationPinned", {
			...scope,
			requestId: "virtual-pin",
			expectedPresentationRevision: 0,
			pinned: true,
		});
		for (let index = 0; index < virtualizationFixture.recentRows; index++) {
			await runtime.call("createConversation", {
				workspaceId: virtualizationWorkspaceIds[Math.floor(index / 100)],
				requestId: `virtual-recent-${index}`,
				// Repeated visible names make canonical identity checks mandatory.
				title: `Virtual Recent ${index % 7} 中文`,
			});
			if ((index + 1) % 100 === 0) progress("virtual-seeded-rows", index + 1);
		}
		await runtime.close();
		progress("virtual-seed-shutdown");
		runtime = await openRuntime(directory, runtimeOptions());
		progress("virtual-cold-open");
		await publishVirtualizationProjection(runtime);
		progress("virtual-projection-ready");
		const recent = [];
		let position = { kind: "head" };
		for (let pageNumber = 0; ; pageNumber++) {
			assert.ok(pageNumber < 20, "Authoritative Recent traversal exceeded fixture bound");
			const page = await runtime.call("listSidebarWindow", {
				view: { kind: "project_recent" },
				filter: "active",
				position,
			});
			assert.equal(page.kind, "window");
			recent.push(
				...page.items.map(({ conversation }) => ({
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
					title: conversation.title,
				})),
			);
			if (!page.nextCursor) break;
			position = { kind: "continue", cursor: page.nextCursor };
		}
		assert.equal(recent.length, virtualizationFixture.recentRows);
		progress("virtual-read-recent-rows", recent.length);
		assert.equal(
			new Set(recent.map((row) => JSON.stringify([row.workspaceId, row.conversationId]))).size,
			recent.length,
		);
		const snapshot = await virtualizationSnapshot(runtime);
		const history = await runtime.call("getHistory", scope);
		assert.deepEqual(history.messages, []);
		progress("virtual-snapshot-rows", snapshot.conversations.length);
		return {
			...virtualizationFixture,
			active: scope,
			recent,
			snapshot,
			handshake: await runtime.call("handshake", {}),
			seedViaPublicRuntime: true,
		};
	} finally {
		await runtime.close();
		progress("virtual-final-shutdown");
	}
}

export async function verifySidebarVirtualization({
	ownedProfileRoot,
	seed,
	gui,
	assertAllOwnedProcessesExited,
	reportProgress,
}) {
	const progress = fixtureProgress(reportProgress);
	progress("virtual-verify-start");
	await assertAllOwnedProcessesExited();
	const runtime = await openRuntime(await ownedHistoryDirectory(ownedProfileRoot), runtimeOptions());
	try {
		progress("virtual-verify-open");
		assert.deepEqual(await runtime.call("handshake", {}), seed.handshake);
		if (gui) {
			const catalog = await runtime.call("getProjectCatalogState", {});
			assert.equal(catalog.state, "ready", "Native startup must finish real logical project adoption");
			assert.equal(
				catalog.defaultWorkspaceId,
				seed.defaultWorkspaceId,
				"Native logical project adoption must bind the default role",
			);
		}
		assert.deepEqual(
			await virtualizationSnapshot(runtime),
			seed.snapshot,
			"Scrolling must not mutate persisted catalog or pins",
		);
		progress("virtual-verify-catalog");
		let checked = 0;
		for (const conversation of seed.snapshot.conversations) {
			const history = await runtime.call("getHistory", {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
			});
			assert.equal(history.nextCursor, null);
			assert.deepEqual(history.messages, [], "No input may submit a turn during the native gate");
			if (++checked % 100 === 0) progress("virtual-verify-empty-histories", checked);
		}
		progress("virtual-verify-complete", checked);
		return { coldCatalogUnchanged: true, conversations: seed.snapshot.conversations.length, submittedTurns: 0 };
	} finally {
		await runtime.close();
		progress("virtual-verify-shutdown");
	}
}
