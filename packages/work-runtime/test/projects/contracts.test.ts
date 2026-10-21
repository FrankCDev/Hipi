import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isProjectMethod,
	isProjectMutationMethod,
	PROJECT_METHODS,
	ProjectContractError,
	parseProjectParams,
	parseProjectResult,
	projectCommandPayload,
} from "../../src/projects/contracts.ts";

const project = { projectId: "project_a", name: "Alpha", revision: 1, homeWorkspaceId: "workspace_a" };
const presentation = { projectId: "project_a", pinned: false, revision: 0 };
const conversation = {
	workspaceId: "workspace_a",
	conversationId: "conversation_a",
	title: "Chat",
	revision: 1,
	createdAt: 0,
	archivedAt: null,
};
const membership = {
	workspaceId: "workspace_a",
	conversationId: "conversation_a",
	projectId: "project_a",
	revision: 1,
};
const state = { state: "ready", generation: 0, defaultWorkspaceId: null };
const adoption = {
	requestId: "adopt_a",
	workspaceId: "default_a",
	expectedCatalogGeneration: 0,
	expectedDefaultWorkspaceId: null,
	provenance: { storeId: "store_a", markerVersion: 1, role: "default-chat-workspace", workspaceId: "default_a" },
};
const fixtures = [
	["getProjectCatalogState", {}, state],
	[
		"listProjects",
		{ cursor: "opaque" },
		{
			items: [{ project, presentation }],
			metadataGeneration: 0,
			orderGeneration: 0,
			previousCursor: null,
			nextCursor: null,
		},
	],
	["getProject", { projectId: "project_a" }, project],
	["getProjectPresentation", { projectId: "project_a" }, presentation],
	[
		"getProjectConversationSummary",
		{ projectId: "project_a", filter: "all" },
		{
			matchedAtLeast: 3,
			complete: true,
			coverage: { generation: "generation", projectMembershipGeneration: 1, state: "ready", completedAt: 1 },
		},
	],
	["getConversationMembership", { workspaceId: "workspace_a", conversationId: "conversation_a" }, membership],
	["getProjectCommandResult", { requestId: "request_a" }, null],
	["adoptLegacyDefaultWorkspace", adoption, { state: "ready", generation: 1, defaultWorkspaceId: "default_a" }],
	["createProject", { requestId: "create_a", name: "Alpha" }, project],
	[
		"createProjectConversation",
		{ requestId: "chat_a", projectId: "project_a", title: "Chat", model: { provider: "openai", modelId: "model-a" } },
		{ conversation, membership },
	],
	["renameProject", { requestId: "rename_a", projectId: "project_a", name: "Alpha", expectedRevision: 1 }, project],
	[
		"setProjectPinned",
		{ requestId: "pin_a", projectId: "project_a", pinned: false, expectedPresentationRevision: 0 },
		presentation,
	],
	[
		"reorderPinnedProject",
		{ requestId: "order_a", movedProjectId: "project_a", beforeProjectId: null, expectedOrderGeneration: 0 },
		{ orderGeneration: 1 },
	],
] as const;

test("every method normalizes and strictly validates params and results", () => {
	assert.equal(fixtures.length, PROJECT_METHODS.length);
	for (const [method, params, result] of fixtures) {
		assert(isProjectMethod(method));
		assert.deepEqual(parseProjectParams(method, params), params);
		assert.deepEqual(parseProjectResult(method, result), result);
		assert.throws(() => parseProjectParams(method, { ...params, unexpected: true }), ProjectContractError);
		if (result !== null)
			assert.throws(() => parseProjectResult(method, { ...result, unexpected: true }), ProjectContractError);
		if (isProjectMutationMethod(method)) {
			const command = { status: "completed", method, params, result };
			assert.deepEqual(parseProjectResult("getProjectCommandResult", command), command);
			assert.throws(
				() => parseProjectResult("getProjectCommandResult", { ...command, stage: "reserved" }),
				ProjectContractError,
			);
		}
	}
});
test("opaque IDs stay separate and names use existing UTF-16 unit bound", () => {
	assert.deepEqual(parseProjectResult("getProject", project), project);
	assert.deepEqual(parseProjectResult("getProject", { ...project, projectId: project.homeWorkspaceId }), {
		...project,
		projectId: project.homeWorkspaceId,
	});
	assert.equal(parseProjectParams("createProject", { requestId: "a", name: "😀".repeat(64) }).name.length, 128);
	assert.throws(
		() => parseProjectParams("createProject", { requestId: "a", name: "😀".repeat(65) }),
		ProjectContractError,
	);
	for (const projectId of ["x\n", "x/../y", "", "x".repeat(129), null, 1])
		assert.throws(() => parseProjectParams("getProject", { projectId }), ProjectContractError);
});
test("all missing required params reject; optional fields normalize away", () => {
	for (const [method, params] of fixtures) {
		for (const key of Object.keys(params)) {
			if (key === "cursor" || key === "model") continue;
			const next = Object.fromEntries(Object.entries(params).filter(([name]) => name !== key));
			assert.throws(() => parseProjectParams(method, next), ProjectContractError, `${method}.${key}`);
		}
	}
	assert.deepEqual(parseProjectParams("listProjects", { cursor: undefined }), {});
	assert.equal(
		projectCommandPayload("createProject", { name: "Alpha", requestId: "create_a" }),
		'{"method":"createProject","params":{"requestId":"create_a","name":"Alpha"}}',
	);
});
test("provenance is explicit, bounded and tied to declared workspace", () => {
	for (const provenance of [
		{ ...adoption.provenance, storeId: "" },
		{ ...adoption.provenance, markerVersion: 2 },
		{ ...adoption.provenance, role: "Chats" },
		{ ...adoption.provenance, workspaceId: "another" },
		{ ...adoption.provenance, path: "/tmp/x" },
	])
		assert.throws(
			() => parseProjectParams("adoptLegacyDefaultWorkspace", { ...adoption, provenance }),
			ProjectContractError,
		);
});
test("pages and linked identity results reject ambiguity", () => {
	const page = {
		items: [{ project, presentation }],
		metadataGeneration: 0,
		orderGeneration: 0,
		previousCursor: null,
		nextCursor: null,
	};
	assert.throws(
		() => parseProjectResult("listProjects", { ...page, items: Array(51).fill(page.items[0]) }),
		ProjectContractError,
	);
	assert.throws(
		() => parseProjectResult("listProjects", { ...page, items: [...page.items, ...page.items] }),
		ProjectContractError,
	);
	assert.throws(
		() =>
			parseProjectResult("listProjects", {
				...page,
				items: [{ project, presentation: { ...presentation, projectId: "other" } }],
			}),
		ProjectContractError,
	);
	assert.throws(
		() =>
			parseProjectResult("createProjectConversation", {
				conversation,
				membership: { ...membership, workspaceId: "other" },
			}),
		ProjectContractError,
	);
	assert.throws(() => parseProjectResult("getConversationMembership", null), ProjectContractError);
	assert.throws(() => parseProjectResult("getProject", null), ProjectContractError);
	assert.throws(() => parseProjectResult("setProjectPinned", { ...presentation, pinned: true }), ProjectContractError);
});
test("pending commands keep exact identities and mutually exclusive stages", () => {
	const commands = [
		{
			status: "pending",
			method: "adoptLegacyDefaultWorkspace",
			params: adoption,
			stage: "backfilling",
			reserved: { workspaceId: "default_a" },
		},
		...["reserved", "physical_created"].map((stage) => ({
			status: "pending",
			method: "createProject",
			params: { requestId: "create_a", name: "Alpha" },
			stage,
			reserved: { projectId: "project_a", workspaceId: "workspace_a" },
		})),
		...["reserved", "workspace_created", "physical_created"].map((stage) => ({
			status: "pending",
			method: "createProjectConversation",
			params: { requestId: "chat_a", projectId: null, title: "Chat" },
			stage,
			reserved: { workspaceId: "default_a", innerRequestId: "physical_a", createDefault: true },
		})),
	];
	for (const command of commands) {
		assert.deepEqual(parseProjectResult("getProjectCommandResult", command), command);
		assert.throws(
			() => parseProjectResult("getProjectCommandResult", { ...command, result: project }),
			ProjectContractError,
		);
		assert.throws(
			() => parseProjectResult("getProjectCommandResult", { ...command, stage: "complete" }),
			ProjectContractError,
		);
		assert.throws(
			() =>
				parseProjectResult("getProjectCommandResult", {
					...command,
					reserved: { ...command.reserved, conversationId: "x" },
				}),
			ProjectContractError,
		);
	}
	const chat = commands[3];
	assert(chat);
	assert.throws(
		() =>
			parseProjectResult("getProjectCommandResult", {
				...chat,
				params: { requestId: "chat_a", projectId: "project_a", title: "Chat" },
			}),
		ProjectContractError,
	);
	assert.throws(
		() =>
			parseProjectResult("getProjectCommandResult", {
				status: "pending",
				method: "renameProject",
				params: fixtures[8][1],
				stage: "reserved",
				reserved: {},
			}),
		ProjectContractError,
	);
});
test("completed command targets must match exact original params", () => {
	for (const [method, params, result] of fixtures) {
		if (!isProjectMutationMethod(method) || result === null) continue;
		let wrong: unknown = result;
		if (method === "createProject" || method === "renameProject") wrong = { ...result, name: "different" };
		if (method === "adoptLegacyDefaultWorkspace") wrong = { ...result, defaultWorkspaceId: "other" };
		if (method === "setProjectPinned") wrong = { projectId: "other", pinned: false, revision: 0 };
		if (method === "createProjectConversation")
			wrong = { conversation, membership: { ...membership, projectId: null } };
		if (method !== "reorderPinnedProject")
			assert.throws(
				() => parseProjectResult("getProjectCommandResult", { status: "completed", method, params, result: wrong }),
				ProjectContractError,
			);
	}
});
test("catalog state and positive revision constraints stay bounded", () => {
	assert.deepEqual(parseProjectResult("getProjectCatalogState", state), state);
	for (const invalid of [
		{ ...state, state: "unknown" },
		{ ...state, reason: "unsafe freeform" },
		{ ...state, reason: "workspace_unavailable" },
		{ ...state, generation: -1 },
		{ ...state, generation: Number.MAX_SAFE_INTEGER + 1 },
	])
		assert.throws(() => parseProjectResult("getProjectCatalogState", invalid), ProjectContractError);
	assert.throws(() => parseProjectResult("getProject", { ...project, revision: 0 }), ProjectContractError);
	assert.throws(
		() => parseProjectResult("getConversationMembership", { ...membership, revision: 0 }),
		ProjectContractError,
	);
	assert.throws(
		() => parseProjectParams("reorderPinnedProject", { ...fixtures[10][1], beforeProjectId: "project_a" }),
		ProjectContractError,
	);
	assert.equal(isProjectMethod("removeProject"), false);
	assert.equal(isProjectMutationMethod("getProject"), false);
});
test("immutable completed results reject impossible revision transitions", () => {
	assert.throws(() => parseProjectResult("createProject", { ...project, revision: 2 }), ProjectContractError);
	assert.throws(
		() =>
			parseProjectResult("createProjectConversation", {
				conversation: { ...conversation, revision: 2 },
				membership,
			}),
		ProjectContractError,
	);
	assert.throws(
		() =>
			parseProjectResult("createProjectConversation", { conversation, membership: { ...membership, revision: 2 } }),
		ProjectContractError,
	);
	for (const index of [8, 9, 10]) {
		const [method, params, result] = fixtures[index];
		assert(result);
		const wrong = method === "reorderPinnedProject" ? { orderGeneration: 3 } : { ...result, revision: 4 };
		assert.throws(
			() => parseProjectResult("getProjectCommandResult", { status: "completed", method, params, result: wrong }),
			ProjectContractError,
		);
	}
});

test("project summary cannot claim an exact count from missing coverage or unbounded payload", () => {
	const coverage = { generation: "generation", projectMembershipGeneration: 1, state: "ready", completedAt: 1 };
	for (const value of [
		{ matchedAtLeast: 129, complete: true, coverage },
		{ matchedAtLeast: 1, complete: true, coverage: { ...coverage, state: "refreshing" } },
		{ matchedAtLeast: 0, complete: true, coverage: { ...coverage, state: "building", completedAt: null } },
		{ matchedAtLeast: 1, complete: false, coverage: { ...coverage, state: "building", completedAt: null } },
		{ matchedAtLeast: 0, complete: true, coverage: { ...coverage, completedAt: null } },
	])
		assert.throws(() => parseProjectResult("getProjectConversationSummary", value));
	for (const value of [
		{ projectId: "project_a" },
		{ projectId: "project_a", filter: "unknown" },
		{ projectId: null, filter: "all" },
	])
		assert.throws(() => parseProjectParams("getProjectConversationSummary", value));
});
