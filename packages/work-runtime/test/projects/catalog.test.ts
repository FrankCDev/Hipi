import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTestRuntime } from "../../src/testing.ts";
import { fixtureRuntime } from "../transport-fixture.ts";

test("production assembly creates, renames and pins logical projects without changing physical identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-projects-"));
	let runtime = await openTestRuntime(directory);
	try {
		const first = await runtime.call("createProject", { requestId: "project", name: "Original" });
		assert.notEqual(first.projectId, first.homeWorkspaceId);
		const c = await runtime.call("createProjectConversation", {
			requestId: "conversation",
			projectId: first.projectId,
			title: "Explicit title",
		});
		assert.equal(c.conversation.workspaceId, first.homeWorkspaceId);
		assert.equal(c.membership.projectId, first.projectId);
		const renamed = await runtime.call("renameProject", {
			requestId: "rename",
			projectId: first.projectId,
			expectedRevision: 1,
			name: "Renamed",
		});
		assert.equal(renamed.name, "Renamed");
		assert.equal((await runtime.call("getWorkspace", { workspaceId: first.homeWorkspaceId })).name, "Original");
		assert.equal(
			(
				await runtime.call("getConversation", {
					workspaceId: c.conversation.workspaceId,
					conversationId: c.conversation.conversationId,
				})
			).title,
			"Explicit title",
		);
		const pin = await runtime.call("setProjectPinned", {
			requestId: "pin",
			projectId: first.projectId,
			expectedPresentationRevision: 0,
			pinned: true,
		});
		assert.equal(pin.pinned, true);
		assert.deepEqual(await runtime.call("getProjectPresentation", { projectId: first.projectId }), pin);
		await assert.rejects(runtime.call("getProjectPresentation", { projectId: "missing" }), { code: "NOT_FOUND" });
		assert.deepEqual(await runtime.call("createProject", { requestId: "project", name: "Original" }), first);
		assert.deepEqual(
			await runtime.call("createProjectConversation", {
				requestId: "conversation",
				projectId: first.projectId,
				title: "Explicit title",
			}),
			c,
		);
		await assert.rejects(runtime.call("createProject", { requestId: "project", name: "Changed" }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual((await runtime.call("listProjects", {})).items, [{ project: renamed, presentation: pin }]);
		assert.deepEqual(
			await runtime.call("getConversationMembership", {
				workspaceId: c.conversation.workspaceId,
				conversationId: c.conversation.conversationId,
			}),
			c.membership,
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("absent default evidence preserves project-only history and explicit projectless send creates a distinct default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-default-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "legacy", name: "Chats" });
		const old = await runtime.call("createConversation", { workspaceId: "legacy", requestId: "old", title: "Old" });
		assert.equal((await runtime.call("getProjectCatalogState", {})).defaultWorkspaceId, null);
		assert.equal((await runtime.call("listProjects", {})).items[0].project.projectId, "legacy");
		const created = await runtime.call("createProjectConversation", {
			requestId: "new",
			projectId: null,
			title: "New",
		});
		assert.notEqual(created.conversation.workspaceId, "legacy");
		assert.equal(created.membership.projectId, null);
		assert.equal(
			(
				await runtime.call("getConversationMembership", {
					workspaceId: "legacy",
					conversationId: old.conversationId,
				})
			).projectId,
			"legacy",
		);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(
			await runtime.call("createProjectConversation", { requestId: "new", projectId: null, title: "New" }),
			created,
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("verified marker adopts exact workspace including archived members and preserves equal display names", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-adopt-"));
	let runtime = await openTestRuntime(directory);
	try {
		for (const workspaceId of ["default", "other"])
			await runtime.call("createWorkspace", { workspaceId, name: "Chats" });
		const c = await runtime.call("createConversation", { workspaceId: "default", requestId: "c", title: "Archived" });
		await runtime.call("archiveConversation", {
			workspaceId: "default",
			conversationId: c.conversationId,
			requestId: "archive",
			expectedRevision: c.revision,
		});
		const identity = await runtime.call("handshake", {});
		const state = await runtime.call("getProjectCatalogState", {});
		const input = {
			requestId: "adopt",
			workspaceId: "default",
			expectedCatalogGeneration: state.generation,
			expectedDefaultWorkspaceId: null,
			provenance: {
				storeId: identity.storeId,
				markerVersion: 1 as const,
				role: "default-chat-workspace" as const,
				workspaceId: "default",
			},
		};
		await assert.rejects(
			runtime.call("adoptLegacyDefaultWorkspace", {
				...input,
				requestId: "bad",
				provenance: { ...input.provenance, storeId: "foreign" },
			}),
			{ code: "STORE_MISMATCH" },
		);
		const result = await runtime.call("adoptLegacyDefaultWorkspace", input);
		assert.equal(result.state, "ready");
		await assert.rejects(runtime.call("getProjectPresentation", { projectId: "default" }), { code: "NOT_FOUND" });
		assert.equal(
			(await runtime.call("getConversationMembership", { workspaceId: "default", conversationId: c.conversationId }))
				.projectId,
			null,
		);
		assert.deepEqual(
			(await runtime.call("listProjects", {})).items.map((x) => x.project.projectId),
			["other"],
		);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("adoptLegacyDefaultWorkspace", input), result);
		const database = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(database.prepare("SELECT version FROM identity").get()?.version, 12);
		} finally {
			database.close();
		}
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const failure of ["after_reserve", "after_directory", "after_storage", "before_ready"] as const)
	test(`logical project creation resumes reserved identity after ${failure}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-project-recovery-"));
		let runtime = await openTestRuntime(directory, {
			catalogFailpoint: async (point) => {
				if (point === failure) throw new Error("interrupt");
			},
		});
		try {
			await assert.rejects(runtime.call("createProject", { requestId: "create", name: "Preserved" }), /interrupt/);
			const pending = await runtime.call("getProjectCommandResult", { requestId: "create" });
			assert.equal(pending?.status, "pending");
			if (pending?.status !== "pending" || pending.method !== "createProject")
				throw new Error("wrong pending owner");
			await runtime.close();
			runtime = await openTestRuntime(directory);
			const project = await runtime.call("createProject", { requestId: "create", name: "Preserved" });
			assert.equal(project.projectId, pending.reserved.projectId);
			assert.equal(project.homeWorkspaceId, pending.reserved.workspaceId);
			assert.equal((await runtime.call("listProjects", {})).items.length, 1);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

test("lost logical commit reply reconciles immutable terminal receipt instead of creating again", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-reply-"));
	let fail = true;
	let runtime = await openTestRuntime(directory, {
		projectFailpoint: (point) => {
			if (point === "after_commit" && fail) {
				fail = false;
				throw new Error("reply lost");
			}
		},
	});
	try {
		await assert.rejects(runtime.call("createProject", { requestId: "p", name: "Original" }), /reply lost/);
		const receipt = await runtime.call("getProjectCommandResult", { requestId: "p" });
		if (receipt?.status !== "completed" || receipt.method !== "createProject")
			throw new Error("missing completed receipt");
		const original = receipt.result;
		await runtime.call("renameProject", {
			requestId: "rename",
			projectId: original.projectId,
			expectedRevision: 1,
			name: "Later",
		});
		assert.deepEqual(await runtime.call("createProject", { requestId: "p", name: "Original" }), original);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("getProjectCommandResult", { requestId: "p" }), receipt);
		assert.equal((await runtime.call("listProjects", {})).items.length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const point of ["after_reserve", "after_physical"] as const)
	test(`logical conversation recovery keeps original project and physical receipt at ${point}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-project-conversation-"));
		let enabled = false;
		let runtime = await openTestRuntime(directory, {
			projectFailpoint: (current) => {
				if (enabled && current === point) throw new Error("interrupt");
			},
		});
		try {
			const project = await runtime.call("createProject", { requestId: "p", name: "P" });
			enabled = true;
			const input = { requestId: "c", projectId: project.projectId, title: "Exact title" };
			await assert.rejects(runtime.call("createProjectConversation", input), /interrupt/);
			const pending = await runtime.call("getProjectCommandResult", { requestId: "c" });
			assert.equal(pending?.status, "pending");
			await runtime.close();
			runtime = await openTestRuntime(directory);
			const completed = await runtime.call("createProjectConversation", input);
			assert.equal(completed.conversation.workspaceId, project.homeWorkspaceId);
			assert.equal(
				(await runtime.call("listConversations", { workspaceId: project.homeWorkspaceId })).items.length,
				1,
			);
			assert.deepEqual(await runtime.call("createProjectConversation", input), completed);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

test("shutdown stops adoption at a safe batch and exact retry resumes without a new execution owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-adoption-shutdown-"));
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let held = false;
	let runtime = await openTestRuntime(directory, {
		projectFailpoint: async (point) => {
			if (point === "adoption_batch" && !held) {
				held = true;
				entered.resolve();
				await release.promise;
			}
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Legacy" });
		const c = await runtime.call("createConversation", { requestId: "c", workspaceId: "old", title: "Keep" });
		await runtime.call("getConversationMembership", { workspaceId: "old", conversationId: c.conversationId });
		const { storeId } = await runtime.call("handshake", {});
		const state = await runtime.call("getProjectCatalogState", {});
		const input = {
			requestId: "adopt",
			workspaceId: "old",
			expectedCatalogGeneration: state.generation,
			expectedDefaultWorkspaceId: null,
			provenance: {
				storeId,
				markerVersion: 1 as const,
				role: "default-chat-workspace" as const,
				workspaceId: "old",
			},
		};
		const operation = runtime.call("adoptLegacyDefaultWorkspace", input);
		const rejected = assert.rejects(operation, { code: "CLOSED" });
		await entered.promise;
		assert.equal((await runtime.call("getProjectCommandResult", { requestId: "adopt" }))?.status, "pending");
		assert.equal((await runtime.call("getProjectCatalogState", {})).state, "adopting");
		const closing = runtime.close();
		release.resolve();
		await rejected;
		await closing;
		runtime = await openTestRuntime(directory);
		assert.equal((await runtime.call("getProjectCatalogState", {})).state, "adopting");
		assert.equal((await runtime.call("adoptLegacyDefaultWorkspace", input)).state, "ready");
		assert.equal(
			(await runtime.call("getConversationMembership", { workspaceId: "old", conversationId: c.conversationId }))
				.projectId,
			null,
		);
	} finally {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("explicit logical membership prevents later legacy default adoption from hiding its project", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-adoption-conflict-"));
	const runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Chats" });
		const project = (await runtime.call("listProjects", {})).items[0].project;
		const c = await runtime.call("createProjectConversation", {
			requestId: "c",
			projectId: project.projectId,
			title: "Explicit",
		});
		const state = await runtime.call("getProjectCatalogState", {}),
			{ storeId } = await runtime.call("handshake", {});
		await assert.rejects(
			runtime.call("adoptLegacyDefaultWorkspace", {
				requestId: "adopt",
				workspaceId: "old",
				expectedCatalogGeneration: state.generation,
				expectedDefaultWorkspaceId: null,
				provenance: { storeId, markerVersion: 1, role: "default-chat-workspace", workspaceId: "old" },
			}),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
		assert.deepEqual(await runtime.call("getProjectCatalogState", {}), state);
		assert.equal((await runtime.call("getProject", { projectId: project.projectId })).name, "Chats");
		assert.deepEqual(
			await runtime.call("getConversationMembership", {
				workspaceId: "old",
				conversationId: c.conversation.conversationId,
			}),
			c.membership,
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("pending default reservation excludes another client and adoption until exact restart recovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-default-reservation-"));
	let fail = false;
	let runtime = await openTestRuntime(directory, {
		projectFailpoint: (point) => {
			if (fail && point === "after_reserve") throw new Error("reserved");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "legacy", name: "Chats" });
		fail = true;
		const first = { requestId: "first", projectId: null, title: "Original" };
		await assert.rejects(runtime.call("createProjectConversation", first), /reserved/);
		const pending = await runtime.call("getProjectCommandResult", { requestId: "first" });
		if (pending?.status !== "pending" || pending.method !== "createProjectConversation")
			throw new Error("missing pending default");
		const { storeId } = await runtime.call("handshake", {});
		const state = await runtime.call("getProjectCatalogState", {});
		await assert.rejects(runtime.call("createProjectConversation", { ...first, requestId: "second" }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		await assert.rejects(
			runtime.call("adoptLegacyDefaultWorkspace", {
				requestId: "adopt",
				workspaceId: "legacy",
				expectedCatalogGeneration: state.generation,
				expectedDefaultWorkspaceId: null,
				provenance: { storeId, workspaceId: "legacy", markerVersion: 1, role: "default-chat-workspace" },
			}),
			{ code: "INDEX_RECOVERY_REQUIRED" },
		);
		assert.equal(await runtime.call("getProjectCommandResult", { requestId: "second" }), null);
		assert.equal((await runtime.call("listWorkspaces", {})).items.length, 1);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("createProjectConversation", { ...first, requestId: "second" }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		const result = await runtime.call("createProjectConversation", first);
		assert.equal(result.conversation.workspaceId, pending.reserved.workspaceId);
		const second = await runtime.call("createProjectConversation", { ...first, requestId: "second" });
		assert.equal(second.conversation.workspaceId, result.conversation.workspaceId);
		assert.equal((await runtime.call("listWorkspaces", {})).items.length, 2);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing optional project assembly fails closed instead of returning decorative success", async () => {
	const runtime = fixtureRuntime();
	try {
		await assert.rejects(runtime.call("listProjects", {}), { code: "INDEX_RECOVERY_REQUIRED" });
		await assert.rejects(runtime.call("createProject", { requestId: "p", name: "P" }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
	} finally {
		await runtime.close();
	}
});

test("cancelWait does not cancel adoption and read-only pending lookup does not advance its batch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-adopt-wait-"));
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let held = false;
	const runtime = await openTestRuntime(directory, {
		projectFailpoint: async (point) => {
			if (point === "adoption_batch" && !held) {
				held = true;
				entered.resolve();
				await release.promise;
			}
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "old", name: "Old" });
		const c = await runtime.call("createConversation", { workspaceId: "old", requestId: "c", title: "C" });
		await runtime.call("getConversationMembership", { workspaceId: "old", conversationId: c.conversationId });
		const { storeId } = await runtime.call("handshake", {}),
			state = await runtime.call("getProjectCatalogState", {});
		const input = {
			requestId: "adopt",
			workspaceId: "old",
			expectedCatalogGeneration: state.generation,
			expectedDefaultWorkspaceId: null,
			provenance: {
				storeId,
				workspaceId: "old",
				markerVersion: 1 as const,
				role: "default-chat-workspace" as const,
			},
		};
		const controller = new AbortController();
		const waiting = runtime.call("adoptLegacyDefaultWorkspace", input, controller.signal);
		const rejected = assert.rejects(waiting, /stopped waiting/);
		await entered.promise;
		controller.abort(new Error("stopped waiting"));
		await rejected;
		const before = await runtime.call("getProjectCommandResult", { requestId: "adopt" });
		assert.equal(before?.status, "pending");
		assert.deepEqual(await runtime.call("getProjectCommandResult", { requestId: "adopt" }), before);
		release.resolve();
		assert.equal((await runtime.call("adoptLegacyDefaultWorkspace", input)).state, "ready");
		assert.equal((await runtime.call("getProjectCommandResult", { requestId: "adopt" }))?.status, "completed");
	} finally {
		release.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("production project summary counts all pinned chats using the existing published projection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-project-count-"));
	const runtime = await openTestRuntime(directory);
	try {
		const project = await runtime.call("createProject", { requestId: "p", name: "P" });
		for (let i = 0; i < 3; i++) {
			const { conversation } = await runtime.call("createProjectConversation", {
				requestId: `c${i}`,
				projectId: project.projectId,
				title: `C${i}`,
			});
			await runtime.call("setConversationPinned", {
				requestId: `pin${i}`,
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				pinned: true,
				expectedPresentationRevision: 0,
			});
		}
		let coverage = await runtime.call("refreshSidebarProjection", {});
		for (let i = 0; i < 100 && coverage.state !== "ready"; i++)
			coverage = await runtime.call("refreshSidebarProjection", {});
		assert.equal(coverage.state, "ready");
		const summary = await runtime.call("getProjectConversationSummary", {
			projectId: project.projectId,
			filter: "all",
		});
		assert.equal(summary.matchedAtLeast, 3);
		assert.equal(summary.complete, true);
		assert.equal(
			(
				await runtime.call("listSidebarConversations", {
					view: { kind: "project", projectId: project.projectId },
					filter: "all",
				})
			).items.length,
			0,
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
