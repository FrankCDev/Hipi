// Source-only synthetic inputs. No fixture is bundled into the application.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { ownedHistoryDirectory } from "../../gui-long-history-fixture.mjs";
import { sidebarWorkspaceIds } from "./manifest.mjs";

export const sidebarFixture = Object.freeze({
	workspaceIds: sidebarWorkspaceIds,
	defaultWorkspaceId: "sidebar-chats",
	recentRows: 24,
	draft: "SIDEBAR_UNSUBMITTED_DRAFT 中文",
	answer: "SIDEBAR_PERSISTED_ANSWER 中文",
});

function options() {
	const faux = fauxProvider({ tokensPerSecond: 100000, tokenSize: { min: 8192, max: 8192 } });
	faux.setResponses([fauxAssistantMessage(sidebarFixture.answer)]);
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

export async function sidebarRuntimeSnapshot(runtime) {
	const workspaces = await runtime.call("listWorkspaces", {});
	assert.equal(workspaces.nextCursor, null);
	const conversations = [];
	for (const workspace of workspaces.items) {
		const page = await runtime.call("listConversations", { workspaceId: workspace.workspaceId, filter: "all" });
		assert.equal(page.nextCursor, null, "Sidebar fixture must remain one bounded catalog page");
		for (const conversation of page.items) {
			const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
			const history = await runtime.call("getHistory", scope);
			assert.equal(history.nextCursor, null);
			conversations.push({ conversation, history });
		}
	}
	const pins = await runtime.call("listPinnedConversations", {});
	assert.equal(pins.nextCursor, null);
	return {
		workspaces: workspaces.items.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
		conversations: conversations.sort((a, b) =>
			a.conversation.conversationId.localeCompare(b.conversation.conversationId),
		),
		pins: pins.items.map(({ conversation }) => ({
			workspaceId: conversation.workspaceId,
			conversationId: conversation.conversationId,
		})),
	};
}

export async function seedSidebar({ ownedProfileRoot, assertAllOwnedProcessesExited }) {
	await assertAllOwnedProcessesExited();
	const directory = await ownedHistoryDirectory(ownedProfileRoot);
	assert.deepEqual(await readdir(directory), []);
	const runtime = await openRuntime(directory, options());
	try {
		for (const [index, workspaceId] of sidebarFixture.workspaceIds.entries())
			await runtime.call("createWorkspace", { workspaceId, name: index === 0 ? "Chats" : `Sidebar project ${index}` });
		const pins = [];
		for (const [index, workspaceId] of sidebarFixture.workspaceIds.entries()) {
			const count = index === 0 ? sidebarFixture.recentRows : index === 1 ? 2 : 1;
			for (let n = 0; n < count; n++) {
				const conversation = await runtime.call("createConversation", {
					workspaceId,
					requestId: `sidebar-create-${index}-${n}`,
					// Repeated visible titles deliberately require canonical scope assertions.
					title: index === 0 ? `Recent ${String(n).padStart(2, "0")}` : "Same pinned title",
				});
				if (index > 0) {
					const scope = { workspaceId, conversationId: conversation.conversationId };
					await runtime.call("setConversationPinned", {
						...scope,
						requestId: `sidebar-pin-${index}-${n}`,
						expectedPresentationRevision: 0,
						pinned: true,
					});
					pins.push(scope);
				}
			}
		}
		await runtime.call("submit", { ...pins[0], requestId: "sidebar-history", text: "SIDEBAR_PERSISTED_USER 中文" });
		const deadline = Date.now() + 30000;
		for (;;) {
			const receipt = await runtime.call("getReceipt", {
				workspaceId: pins[0].workspaceId,
				requestId: "sidebar-history",
			});
			if (receipt?.execution === "done") break;
			assert.ok(
				Date.now() < deadline && !["failed", "cancelled"].includes(receipt?.execution),
				"Sidebar seed did not complete",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const handshake = await runtime.call("handshake", {});
		const snapshot = await sidebarRuntimeSnapshot(runtime);
		assert.equal(snapshot.pins.length, 3);
		return { ...sidebarFixture, handshake, pins, snapshot, seedViaPublicRuntime: true };
	} finally {
		await runtime.close();
	}
}

export async function verifySidebar({ ownedProfileRoot, seed, gui, assertAllOwnedProcessesExited }) {
	await assertAllOwnedProcessesExited();
	const runtime = await openRuntime(await ownedHistoryDirectory(ownedProfileRoot), options());
	try {
		assert.deepEqual(await runtime.call("handshake", {}), seed.handshake, "Cold verification must use the same store");
		const snapshot = await sidebarRuntimeSnapshot(runtime);
		assert.deepEqual(snapshot.workspaces, seed.snapshot.workspaces, "Sidebar must not alter project membership");
		assert.deepEqual(
			snapshot.conversations,
			seed.snapshot.conversations,
			"Sidebar must not alter conversation/history data",
		);
		assert.deepEqual(snapshot.pins, gui.final.pins, "Cold runtime order must equal exact rendered canonical scopes");
		assert.deepEqual(
			[...snapshot.pins].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
			[...seed.pins].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
		);
		return { cleanColdRead: true, exactMembershipPreserved: true, historyPreserved: true, pins: snapshot.pins };
	} finally {
		await runtime.close();
	}
}
