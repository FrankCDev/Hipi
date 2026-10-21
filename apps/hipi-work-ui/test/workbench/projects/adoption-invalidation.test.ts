import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { invalidateProjectCatalog } from "../../../src/features/workbench/projects/invalidation.ts";

test("confirmed adoption refreshes a mixed-pin read rejected during the logical transition", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-adoption-refresh-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = await openTestRuntime(directory, {
		projectFailpoint: async (point) => {
			if (point === "adoption_batch") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	let unsubscribe = () => {};
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Chats" });
		await runtime.call("createConversation", { workspaceId: "old", requestId: "old-chat", title: "Old" });
		const project = await runtime.call("createProject", { requestId: "project", name: "Project" });
		const { conversation } = await runtime.call("createProjectConversation", {
			requestId: "chat",
			projectId: project.projectId,
			title: "Pinned",
		});
		await runtime.call("setConversationPinned", {
			workspaceId: conversation.workspaceId,
			conversationId: conversation.conversationId,
			requestId: "pin",
			pinned: true,
			expectedPresentationRevision: 0,
		});
		const state = await runtime.call("getProjectCatalogState", {});
		const { storeId } = await runtime.call("handshake", {});
		const adoption = runtime.call("adoptLegacyDefaultWorkspace", {
			requestId: "adopt",
			workspaceId: "old",
			expectedCatalogGeneration: state.generation,
			expectedDefaultWorkspaceId: null,
			provenance: { storeId, workspaceId: "old", markerVersion: 1, role: "default-chat-workspace" },
		});
		await entered.promise;
		let reads = 0;
		const observer = new QueryObserver(cache, {
			queryKey: ["sidebar-pins", "pages"],
			retry: false,
			queryFn: () => {
				reads++;
				return runtime.call("listSidebarPins", {});
			},
		});
		const rejected = Promise.withResolvers<void>();
		const recovered = Promise.withResolvers<void>();
		unsubscribe = observer.subscribe((value) => {
			if (value.isError) rejected.resolve();
			if (value.isSuccess) recovered.resolve();
		});
		await rejected.promise;
		assert.equal((observer.getCurrentResult().error as { code?: string }).code, "INDEX_RECOVERY_REQUIRED");
		invalidateProjectCatalog(cache, false);
		assert.equal(reads, 1, "An unconfirmed adoption does not retry the fenced pin read");
		release.resolve();
		assert.equal((await adoption).state, "ready");
		assert.equal(observer.getCurrentResult().isError, true, "Completion alone does not retire the failed query");
		assert.equal(reads, 1);
		invalidateProjectCatalog(cache);
		await recovered.promise;
		assert.equal(reads, 2, "One catalog-owned refresh, not a retry loop");
		assert.equal(observer.getCurrentResult().data?.items.length, 1);
		assert.deepEqual(
			(await runtime.call("listProjects", {})).items.map((item) => item.project.projectId),
			[project.projectId],
		);
	} finally {
		release.resolve();
		unsubscribe();
		cache.clear();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
