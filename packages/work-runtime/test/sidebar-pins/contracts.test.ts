import assert from "node:assert/strict";
import test from "node:test";
import {
	isSidebarPinMethod,
	isSidebarPinMutationMethod,
	type PinKey,
	parsePinKey,
	parseSidebarPinItem,
	parseSidebarPinParams,
	parseSidebarPinResult,
	type ReorderSidebarPin,
	SIDEBAR_PIN_METHODS,
	SidebarPinContractError,
	type SidebarPinItem,
	samePinKey,
	sidebarPinCommandPayload,
} from "../../src/sidebar-pins/contracts.ts";

const projectKey: PinKey = { kind: "project", projectId: "shared" };
const conversationKey: PinKey = { kind: "conversation", workspaceId: "workspace_a", conversationId: "shared" };
const otherConversation: PinKey = { kind: "conversation", workspaceId: "workspace_b", conversationId: "shared" };
const reorder: ReorderSidebarPin = {
	requestId: "reorder_a",
	moved: projectKey,
	before: conversationKey,
	expectedOrderRevision: 3,
};
const project: Extract<SidebarPinItem, { kind: "project" }> = {
	kind: "project",
	project: { projectId: "shared", name: "Project name", revision: 2, homeWorkspaceId: "workspace_a" },
	presentation: { projectId: "shared", pinned: true, revision: 1 },
};
const conversation: Extract<SidebarPinItem, { kind: "conversation" }> = {
	kind: "conversation",
	conversation: {
		workspaceId: "workspace_a",
		conversationId: "shared",
		title: "Conversation title",
		revision: 2,
		createdAt: null,
		archivedAt: null,
	},
	presentation: { workspaceId: "workspace_a", conversationId: "shared", pinned: true, revision: 1 },
	membership: { workspaceId: "workspace_a", conversationId: "shared", projectId: "another_project", revision: 2 },
};

test("typed pin identity preserves cross-kind IDs and canonical conversation scopes", () => {
	for (const key of [projectKey, conversationKey, otherConversation]) assert.deepEqual(parsePinKey(key), key);
	assert.equal(samePinKey(projectKey, { ...projectKey }), true);
	assert.equal(samePinKey(conversationKey, { ...conversationKey }), true);
	assert.equal(samePinKey(projectKey, conversationKey), false);
	assert.equal(samePinKey(conversationKey, projectKey), false);
	assert.equal(samePinKey(conversationKey, otherConversation), false);
	for (const invalid of [
		{ kind: "project" },
		{ kind: "conversation", conversationId: "shared" },
		{ kind: "conversation", workspaceId: "workspace_a" },
		{ ...projectKey, workspaceId: "workspace_a" },
		{ ...conversationKey, projectId: "shared" },
		{ kind: "workspace", workspaceId: "workspace_a" },
		null,
		[],
		"project:shared",
	])
		assert.throws(() => parsePinKey(invalid), SidebarPinContractError);
	for (const invalidId of ["", "x/y", "x\n", " ", "x".repeat(129), 1, null]) {
		assert.throws(() => parsePinKey({ kind: "project", projectId: invalidId }), SidebarPinContractError);
		assert.throws(() => parsePinKey({ ...conversationKey, workspaceId: invalidId }), SidebarPinContractError);
	}
});

test("reorder params support cross-kind and unloaded anchors with explicit absolute end", () => {
	assert.deepEqual(parseSidebarPinParams("reorderSidebarPin", reorder), reorder);
	assert.deepEqual(parseSidebarPinParams("reorderSidebarPin", { ...reorder, before: null }), {
		...reorder,
		before: null,
	});
	assert.deepEqual(
		parseSidebarPinParams("reorderSidebarPin", { ...reorder, moved: conversationKey, before: otherConversation }),
		{ ...reorder, moved: conversationKey, before: otherConversation },
	);
	for (const moved of [projectKey, conversationKey])
		assert.throws(
			() => parseSidebarPinParams("reorderSidebarPin", { ...reorder, moved, before: { ...moved } }),
			SidebarPinContractError,
		);
	for (const missing of Object.keys(reorder)) {
		const input = Object.fromEntries(Object.entries(reorder).filter(([key]) => key !== missing));
		assert.throws(() => parseSidebarPinParams("reorderSidebarPin", input), SidebarPinContractError);
	}
	for (const input of [
		{ ...reorder, requestId: "" },
		{ ...reorder, requestId: "a\n" },
		{ ...reorder, requestId: "x".repeat(129) },
		{ ...reorder, projectId: "shared" },
		{ ...reorder, before: undefined },
	])
		assert.throws(() => parseSidebarPinParams("reorderSidebarPin", input), SidebarPinContractError);
	for (const expectedOrderRevision of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "3", null])
		assert.throws(
			() => parseSidebarPinParams("reorderSidebarPin", { ...reorder, expectedOrderRevision }),
			SidebarPinContractError,
		);
});

test("command payload normalization is stable without changing input or legacy command identity", () => {
	const reorderedFields = {
		expectedOrderRevision: 3,
		before: { conversationId: "shared", workspaceId: "workspace_a", kind: "conversation" as const },
		moved: { projectId: "shared", kind: "project" as const },
		requestId: "reorder_a",
	};
	const original = structuredClone(reorderedFields);
	assert.equal(
		sidebarPinCommandPayload("reorderSidebarPin", reorderedFields),
		sidebarPinCommandPayload("reorderSidebarPin", reorder),
	);
	assert.equal(
		sidebarPinCommandPayload("reorderSidebarPin", reorder),
		'{"method":"reorderSidebarPin","params":{"requestId":"reorder_a","moved":{"kind":"project","projectId":"shared"},"before":{"kind":"conversation","workspaceId":"workspace_a","conversationId":"shared"},"expectedOrderRevision":3}}',
	);
	assert.deepEqual(reorderedFields, original);
	assert.notEqual(
		sidebarPinCommandPayload("reorderSidebarPin", reorder),
		sidebarPinCommandPayload("reorderSidebarPin", { ...reorder, before: otherConversation }),
	);
});

test("mixed page preserves order, matching metadata and explicit projectless membership", () => {
	const items: SidebarPinItem[] = [
		conversation,
		project,
		{
			...conversation,
			conversation: { ...conversation.conversation, workspaceId: "workspace_b" },
			presentation: { ...conversation.presentation, workspaceId: "workspace_b" },
			membership: { ...conversation.membership, workspaceId: "workspace_b", projectId: null },
		},
	];
	const page = { items, nextCursor: "opaque", nextPinKey: { kind: "project", projectId: "next" }, orderRevision: 3 };
	assert.deepEqual(parseSidebarPinResult("listSidebarPins", page), page);
	assert.deepEqual(
		parseSidebarPinResult("listSidebarPins", {
			items: [],
			nextCursor: "opaque",
			nextPinKey: projectKey,
			orderRevision: 0,
		}),
		{
			items: [],
			nextCursor: "opaque",
			nextPinKey: projectKey,
			orderRevision: 0,
		},
	);
	assert.deepEqual(parseSidebarPinItem(project), project);
	assert.deepEqual(parseSidebarPinItem(conversation), conversation);
	for (const repeated of [project, conversation])
		assert.throws(
			() => parseSidebarPinResult("listSidebarPins", { ...page, items: [repeated, repeated] }),
			SidebarPinContractError,
		);
});

test("mixed page candidate and cursor bounds reject oversized or malformed envelopes", () => {
	const items = Array.from({ length: 50 }, (_, index) => ({
		...project,
		project: { ...project.project, projectId: `p${index}` },
		presentation: { ...project.presentation, projectId: `p${index}` },
	}));
	assert.equal(
		parseSidebarPinResult("listSidebarPins", {
			items,
			nextCursor: "x".repeat(2048),
			nextPinKey: projectKey,
			orderRevision: 1,
		}).items.length,
		50,
	);
	assert.throws(
		() =>
			parseSidebarPinResult("listSidebarPins", {
				items: [...items, project],
				nextCursor: null,
				nextPinKey: null,
				orderRevision: 1,
			}),
		SidebarPinContractError,
	);
	for (const nextCursor of ["", "x".repeat(2049), undefined, 1])
		assert.throws(
			() =>
				parseSidebarPinResult("listSidebarPins", {
					items: [],
					nextCursor,
					nextPinKey: projectKey,
					orderRevision: 1,
				}),
			SidebarPinContractError,
		);
	for (const orderRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null])
		assert.throws(
			() =>
				parseSidebarPinResult("listSidebarPins", { items: [], nextCursor: null, nextPinKey: null, orderRevision }),
			SidebarPinContractError,
		);
	assert.throws(
		() =>
			parseSidebarPinResult("listSidebarPins", {
				items: [],
				nextCursor: null,
				nextPinKey: null,
				orderRevision: 0,
				orderGeneration: 0,
			}),
		SidebarPinContractError,
	);
});

test("mixed items reject unpinned, archived, mismatched and cross-variant records", () => {
	for (const invalid of [
		{ ...project, presentation: { ...project.presentation, projectId: "other" } },
		{ ...project, presentation: { ...project.presentation, pinned: false } },
		{ ...project, presentation: { ...project.presentation, revision: 0 } },
		{ ...project, conversation: conversation.conversation },
		{ ...project, membership: conversation.membership },
		{ ...project, project: { ...project.project, unexpected: true } },
		{ ...conversation, membership: undefined },
		{ ...conversation, membership: { ...conversation.membership, workspaceId: "other" } },
		{ ...conversation, membership: { ...conversation.membership, conversationId: "other" } },
		{ ...conversation, membership: { ...conversation.membership, revision: 0 } },
		{ ...conversation, presentation: { ...conversation.presentation, workspaceId: "other" } },
		{ ...conversation, presentation: { ...conversation.presentation, conversationId: "other" } },
		{ ...conversation, presentation: { ...conversation.presentation, pinned: false } },
		{ ...conversation, presentation: { ...conversation.presentation, revision: 0 } },
		{ ...conversation, conversation: { ...conversation.conversation, archivedAt: 0 } },
		{ ...conversation, conversation: { ...conversation.conversation, createdAt: -1 } },
		{ ...conversation, conversation: { ...conversation.conversation, revision: 0 } },
		{ ...conversation, conversation: { ...conversation.conversation, unexpected: true } },
		{ ...conversation, project: project.project },
	])
		assert.throws(() => parseSidebarPinItem(invalid));
});

test("mixed page lookahead is mandatory, correlated with continuation and absent from loaded canonical keys", () => {
	for (const [items, nextPinKey] of [
		[[project], conversationKey],
		[[conversation], projectKey],
		[[conversation], otherConversation],
	] as [SidebarPinItem[], PinKey][]) {
		const page = { items, nextCursor: "opaque", nextPinKey, orderRevision: 3 };
		assert.deepEqual(parseSidebarPinResult("listSidebarPins", page), page);
	}
	const terminal = { items: [project, conversation], nextCursor: null, nextPinKey: null, orderRevision: 3 };
	assert.deepEqual(parseSidebarPinResult("listSidebarPins", terminal), terminal);
	for (const invalid of [
		{ ...terminal, nextPinKey: undefined },
		{ ...terminal, nextCursor: "opaque" },
		{ ...terminal, nextPinKey: projectKey },
		{ ...terminal, nextCursor: "opaque", nextPinKey: projectKey },
		{ ...terminal, nextCursor: "opaque", nextPinKey: conversationKey },
		{ ...terminal, nextCursor: "opaque", nextPinKey: { ...otherConversation, projectId: "extra" } },
	])
		assert.throws(() => parseSidebarPinResult("listSidebarPins", invalid), SidebarPinContractError);
});

test("command lookup retains immutable normalized reorder result and rejects impossible transitions", () => {
	assert.equal(parseSidebarPinResult("getSidebarPinCommandResult", null), null);
	for (const orderRevision of [3, 4]) {
		const command = { method: "reorderSidebarPin", params: reorder, result: { orderRevision } };
		assert.deepEqual(parseSidebarPinResult("getSidebarPinCommandResult", command), command);
	}
	for (const invalid of [
		{ method: "reorderPinnedConversation", params: reorder, result: { orderRevision: 4 } },
		{ method: "reorderSidebarPin", params: reorder, result: { orderRevision: 2 } },
		{ method: "reorderSidebarPin", params: reorder, result: { orderRevision: 5 } },
		{ method: "reorderSidebarPin", params: reorder, result: { orderRevision: 4, orderGeneration: 4 } },
		{ method: "reorderSidebarPin", params: reorder, result: { orderRevision: 4 }, status: "completed" },
		{ method: "reorderSidebarPin", params: reorder, status: "pending" },
		{ method: "reorderSidebarPin", params: { ...reorder, before: projectKey }, result: { orderRevision: 4 } },
	])
		assert.throws(() => parseSidebarPinResult("getSidebarPinCommandResult", invalid), SidebarPinContractError);
	assert.deepEqual(
		parseSidebarPinResult("getSidebarPinCommandResult", {
			method: "reorderSidebarPin",
			params: { ...reorder, expectedOrderRevision: Number.MAX_SAFE_INTEGER },
			result: { orderRevision: Number.MAX_SAFE_INTEGER },
		}),
		{
			method: "reorderSidebarPin",
			params: { ...reorder, expectedOrderRevision: Number.MAX_SAFE_INTEGER },
			result: { orderRevision: Number.MAX_SAFE_INTEGER },
		},
	);
});

test("method predicates and read params accept only the additive mixed pin methods", () => {
	assert.equal(SIDEBAR_PIN_METHODS.length, 3);
	for (const method of SIDEBAR_PIN_METHODS) assert.equal(isSidebarPinMethod(method), true);
	for (const method of ["reorderPinnedConversation", "reorderPinnedProject", "setSidebarPin", "removeProject", null])
		assert.equal(isSidebarPinMethod(method), false);
	assert.equal(isSidebarPinMutationMethod("reorderSidebarPin"), true);
	assert.equal(isSidebarPinMutationMethod("listSidebarPins"), false);
	assert.deepEqual(parseSidebarPinParams("listSidebarPins", {}), {});
	assert.deepEqual(parseSidebarPinParams("listSidebarPins", { cursor: undefined }), {});
	assert.deepEqual(parseSidebarPinParams("listSidebarPins", { cursor: "opaque" }), { cursor: "opaque" });
	assert.deepEqual(parseSidebarPinParams("getSidebarPinCommandResult", { requestId: "reorder_a" }), {
		requestId: "reorder_a",
	});
	for (const input of [{ cursor: "" }, { cursor: "x".repeat(2049) }, { cursor: null }, { limit: 50 }])
		assert.throws(() => parseSidebarPinParams("listSidebarPins", input), SidebarPinContractError);
	for (const input of [{}, { requestId: "" }, { requestId: "reorder_a", method: "reorderSidebarPin" }])
		assert.throws(() => parseSidebarPinParams("getSidebarPinCommandResult", input), SidebarPinContractError);
	assert.deepEqual(parseSidebarPinResult("reorderSidebarPin", { orderRevision: 4 }), { orderRevision: 4 });
	assert.throws(
		() => parseSidebarPinResult("reorderSidebarPin", { orderRevision: 4, pinned: true }),
		SidebarPinContractError,
	);
});
