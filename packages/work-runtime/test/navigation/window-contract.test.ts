import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	LIMITS,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type Scope,
	type SidebarConversation,
	type SidebarCoverage,
	type SidebarWindowRequest,
	type SidebarWindowResult,
} from "../../src/contracts.ts";
import { type RuntimePorts, WorkRuntime } from "../../src/core.ts";
import { NAVIGATION_LIMITS } from "../../src/navigation/contracts.ts";
import { openTestRuntime } from "../../src/testing.ts";

const scope: Scope = { workspaceId: "workspace", conversationId: "conversation" };
const coverage: SidebarCoverage = {
	generation: "generation",
	membershipGeneration: 1,
	state: "ready",
	completedAt: 123,
	nextCursor: null,
};
const building: SidebarCoverage = { ...coverage, state: "building", completedAt: null, nextCursor: "refresh" };
const refreshing: SidebarCoverage = { ...coverage, state: "refreshing", nextCursor: "refresh" };
const logicalCoverage: SidebarCoverage = {
	...coverage,
	projectMembershipGeneration: 2,
	projectOrderGeneration: 3,
};

function row(conversationId = scope.conversationId, workspaceId = scope.workspaceId): SidebarConversation {
	return {
		conversation: { workspaceId, conversationId, title: "Title", revision: 1, createdAt: 123, archivedAt: null },
		recencyAt: 123,
		activityBasis: "creation",
	};
}
function windowResult(): Extract<SidebarWindowResult, { kind: "window" }> {
	return {
		kind: "window",
		coverage,
		items: [row()],
		previousCursor: null,
		nextCursor: "next",
		retained: { eligible: [], unavailable: [] },
	};
}
function request(params: unknown) {
	return parseRequest({ version: PROTOCOL_VERSION, method: "listSidebarWindow", params });
}

test("window requests accept every view and position without changing protocol 9", () => {
	assert.equal(PROTOCOL_VERSION, 9);
	const views: SidebarWindowRequest["view"][] = [
		{ kind: "recent" },
		{ kind: "project_recent" },
		{ kind: "workspace", workspaceId: "workspace" },
		{ kind: "project", projectId: null },
		{ kind: "project", projectId: "project" },
	];
	const positions: SidebarWindowRequest["position"][] = [
		{ kind: "head" },
		{ kind: "continue", cursor: "cursor" },
		{ kind: "around", anchor: scope },
	];
	for (const view of views)
		for (const position of positions)
			for (const filter of [undefined, "active", "archived", "all"] as const) {
				const params = { view, position, ...(filter === undefined ? {} : { filter }) };
				assert.deepEqual(request(params), { version: PROTOCOL_VERSION, method: "listSidebarWindow", params });
			}
});

test("retained request scopes are bounded before canonical deduplication", () => {
	const params: SidebarWindowRequest = { view: { kind: "recent" }, position: { kind: "head" } };
	const duplicate = { conversationId: scope.conversationId, workspaceId: scope.workspaceId };
	assert.deepEqual(request({ ...params, retainedScopes: [scope, duplicate] }).params, {
		...params,
		retainedScopes: [scope],
	});
	const other = { ...scope, workspaceId: "other" };
	assert.deepEqual(request({ ...params, retainedScopes: [scope, other] }).params, {
		...params,
		retainedScopes: [scope, other],
	});
	assert.deepEqual(request({ ...params, retainedScopes: [] }).params, { ...params, retainedScopes: [] });
	for (const retainedScopes of [null, {}, [scope, scope, scope], [{ ...scope, extra: true }], [null], new Array(1)])
		assert.throws(() => request({ ...params, retainedScopes }), { code: "INVALID_REQUEST" });
	assert.equal(NAVIGATION_LIMITS.retained, 2);
});

test("window request positions, scopes and views reject unknown or mixed fields", () => {
	const base = { view: { kind: "recent" }, position: { kind: "head" } };
	for (const position of [
		undefined,
		null,
		{},
		{ kind: "previous" },
		{ kind: "head", cursor: "cursor" },
		{ kind: "head", anchor: scope },
		{ kind: "continue" },
		{ kind: "continue", cursor: "" },
		{ kind: "continue", cursor: "x".repeat(LIMITS.cursor + 1) },
		{ kind: "continue", cursor: "cursor", anchor: scope },
		{ kind: "around" },
		{ kind: "around", anchor: { ...scope, projectId: null } },
		{ kind: "around", anchor: { ...scope, workspaceId: "../other" } },
		{ kind: "around", anchor: scope, cursor: "cursor" },
	])
		assert.throws(() => request({ ...base, position }), { code: "INVALID_REQUEST" });
	for (const view of [
		{ kind: "recent", workspaceId: "workspace" },
		{ kind: "project_recent", projectId: null },
		{ kind: "workspace" },
		{ kind: "project" },
		{ kind: "project", projectId: "project", workspaceId: "workspace" },
		{ kind: "unknown" },
	])
		assert.throws(() => request({ ...base, view }), { code: "INVALID_REQUEST" });
	for (const extra of [{ cursor: "old" }, { direction: "before" }, { filter: "unknown" }, { limit: 100 }])
		assert.throws(() => request({ ...base, ...extra }), { code: "INVALID_REQUEST" });
});

test("window result preserves canonical rows, both cursor directions and retained overlap", () => {
	for (const currentCoverage of [coverage, refreshing]) {
		const value = {
			...windowResult(),
			coverage: currentCoverage,
			previousCursor: "previous",
			retained: {
				eligible: [{ row: row(), placement: "inside" as const }],
				unavailable: [{ scope: { ...scope, conversationId: "missing" }, reason: "missing" as const }],
			},
		};
		assert.deepEqual(parseResult("listSidebarWindow", value), value);
	}
	for (const placement of ["before", "inside", "after"] as const) {
		const value = { ...windowResult(), retained: { eligible: [{ row: row(), placement }], unavailable: [] } };
		assert.deepEqual(parseResult("listSidebarWindow", value), value);
	}
	const empty = { ...windowResult(), items: [], previousCursor: "previous" };
	assert.deepEqual(parseResult("listSidebarWindow", empty), empty);
});

test("window and unavailable result branches require a published coverage generation", () => {
	assert.deepEqual(parseResult("listSidebarWindow", { kind: "unpublished", coverage: building }), {
		kind: "unpublished",
		coverage: building,
	});
	for (const currentCoverage of [coverage, refreshing])
		for (const reason of ["missing", "ineligible"] as const) {
			const value = { kind: "anchor_unavailable", coverage: currentCoverage, anchor: scope, reason };
			assert.deepEqual(parseResult("listSidebarWindow", value), value);
		}
	for (const invalid of [
		{ kind: "unpublished", coverage },
		{ kind: "unpublished", coverage: refreshing },
		{ kind: "unpublished", coverage: building, items: [] },
		{ ...windowResult(), coverage: building },
		{ kind: "anchor_unavailable", coverage: building, anchor: scope, reason: "missing" },
		{ kind: "anchor_unavailable", coverage, anchor: scope, reason: "unknown" },
		{ kind: "anchor_unavailable", coverage, anchor: { ...scope, extra: true }, reason: "missing" },
		{ kind: "anchor_unavailable", coverage, anchor: scope, reason: "missing", retained: {} },
		{ kind: "unknown", coverage },
	])
		assert.throws(() => parseResult("listSidebarWindow", invalid), { code: "INVALID_REQUEST" });
});

test("main rows are capped at 50 and deduplicated by full Scope", () => {
	const full = { ...windowResult(), items: Array.from({ length: 50 }, (_, index) => row(`conversation_${index}`)) };
	assert.deepEqual(parseResult("listSidebarWindow", full), full);
	assert.throws(() => parseResult("listSidebarWindow", { ...full, items: [...full.items, row("extra")] }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("listSidebarWindow", { ...full, items: [row(), row()] }), {
		code: "INVALID_REQUEST",
	});
	const crossWorkspace = { ...windowResult(), items: [row(), row(scope.conversationId, "other")] };
	assert.deepEqual(parseResult("listSidebarWindow", crossWorkspace), crossWorkspace);
});

test("retained proofs share a combined cap and unique canonical identities", () => {
	const eligible = { row: row(), placement: "inside" };
	const unavailable = { scope, reason: "ineligible" };
	for (const retained of [
		{ eligible: [eligible, eligible], unavailable: [] },
		{ eligible: [], unavailable: [unavailable, unavailable] },
		{ eligible: [eligible], unavailable: [unavailable] },
		{ eligible: [eligible, { row: row("other"), placement: "after" }], unavailable: [{ scope, reason: "missing" }] },
		{
			eligible: [],
			unavailable: [
				unavailable,
				{ scope: { ...scope, conversationId: "other" }, reason: "missing" },
				{ scope: { ...scope, conversationId: "third" }, reason: "missing" },
			],
		},
	])
		assert.throws(() => parseResult("listSidebarWindow", { ...windowResult(), retained }), {
			code: "INVALID_REQUEST",
		});
	const distinct = {
		...windowResult(),
		retained: {
			eligible: [eligible],
			unavailable: [{ scope: { ...scope, workspaceId: "other" }, reason: "missing" }],
		},
	};
	assert.deepEqual(parseResult("listSidebarWindow", distinct), distinct);
});

test("main and retained rows share strict activity and canonical membership validation", () => {
	const logical = { ...row(), membership: { ...scope, projectId: null, revision: 1 } };
	const valid = {
		...windowResult(),
		coverage: logicalCoverage,
		items: [logical],
		retained: { eligible: [{ row: logical, placement: "inside" }], unavailable: [] },
	};
	assert.deepEqual(parseResult("listSidebarWindow", valid), valid);
	for (const invalidRow of [
		row(),
		{ ...logical, membership: { ...logical.membership, conversationId: "other" } },
		{ ...logical, membership: { ...logical.membership, workspaceId: "other" } },
		{ ...logical, membership: { ...logical.membership, extra: true } },
		{ ...logical, activityBasis: "unknown" },
		{ ...logical, recencyAt: null },
		{ ...logical, extra: true },
	]) {
		assert.throws(() => parseResult("listSidebarWindow", { ...valid, items: [invalidRow] }), {
			code: "INVALID_REQUEST",
		});
		assert.throws(
			() =>
				parseResult("listSidebarWindow", {
					...valid,
					retained: { eligible: [{ row: invalidRow, placement: "inside" }], unavailable: [] },
				}),
			{ code: "INVALID_REQUEST" },
		);
	}
	assert.throws(() => parseResult("listSidebarWindow", { ...windowResult(), items: [logical] }), {
		code: "INVALID_REQUEST",
	});
	for (const field of ["projectMembershipGeneration", "projectOrderGeneration"])
		assert.throws(
			() => parseResult("listSidebarWindow", { ...valid, coverage: { ...logicalCoverage, [field]: undefined } }),
			{
				code: "INVALID_REQUEST",
			},
		);
});

test("window results reject unknown keys and malformed cursors or retained proof branches", () => {
	for (const extra of [
		{ extra: true },
		{ previousCursor: undefined },
		{ previousCursor: "" },
		{ nextCursor: "x".repeat(LIMITS.cursor + 1) },
		{ retained: undefined },
		{ retained: { eligible: [], unavailable: [], extra: true } },
		{ retained: { eligible: [{ row: row(), placement: "unknown" }], unavailable: [] } },
		{ retained: { eligible: [{ row: row(), placement: "inside", extra: true }], unavailable: [] } },
		{ retained: { eligible: [], unavailable: [{ scope, reason: "unknown" }] } },
		{ retained: { eligible: [], unavailable: [{ scope: { ...scope, extra: true }, reason: "missing" }] } },
		{ retained: { eligible: [], unavailable: [{ scope, reason: "missing", extra: true }] } },
	])
		assert.throws(() => parseResult("listSidebarWindow", { ...windowResult(), ...extra }), {
			code: "INVALID_REQUEST",
		});
});

test("existing sidebar request and page parsing retain their established wire shape", () => {
	const params = { view: { kind: "project", projectId: null }, filter: "all", cursor: "cursor" };
	assert.deepEqual(
		parseRequest({ version: PROTOCOL_VERSION, method: "listSidebarConversations", params }).params,
		params,
	);
	const value = { coverage, items: [row()], nextCursor: "next" };
	assert.deepEqual(parseResult("listSidebarConversations", value), value);
	assert.deepEqual(parseResult("listSidebarConversations", { coverage: building, items: [], nextCursor: null }), {
		coverage: building,
		items: [],
		nextCursor: null,
	});
});

test("WorkRuntime routes window requests without opening a workspace and keeps the store fence", async () => {
	let received: SidebarWindowRequest | undefined;
	let closes = 0;
	const expected = windowResult();
	const partial: Partial<RuntimePorts> = {
		storeId: "store",
		listSidebarWindow: async (input) => {
			received = input;
			return expected;
		},
		close: async () => {
			closes++;
		},
	};
	const ports = new Proxy(partial, {
		get(target, key) {
			if (key === "stopProjectWork") return undefined;
			if (key in target) return Reflect.get(target, key);
			throw new Error(`Unexpected runtime port: ${String(key)}`);
		},
	}) as RuntimePorts;
	const runtime = new WorkRuntime(ports);
	try {
		const input: SidebarWindowRequest = {
			view: { kind: "recent" },
			position: { kind: "around", anchor: scope },
			retainedScopes: [scope, scope],
		};
		assert.deepEqual(await runtime.call("listSidebarWindow", input), expected);
		assert.deepEqual(received, { ...input, retainedScopes: [scope] });
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				expectedStoreId: "foreign",
				method: "listSidebarWindow",
				params: input,
			}),
			{ code: "STORE_MISMATCH" },
		);
	} finally {
		await runtime.close();
	}
	assert.equal(closes, 1);
});

test("Node runtime and StoreCatalog route unpublished and anchored windows through the projection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-window-contract-"));
	const runtime = await openTestRuntime(directory);
	try {
		const unpublished = await runtime.call("listSidebarWindow", {
			view: { kind: "recent" },
			position: { kind: "head" },
		});
		assert.equal(unpublished.kind, "unpublished");
		assert.deepEqual(parseResult("listSidebarWindow", unpublished), unpublished);
		await runtime.call("createWorkspace", { workspaceId: "workspace", name: "Workspace" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "workspace",
			requestId: "create",
			title: "Window conversation",
		});
		let current = await runtime.call("refreshSidebarProjection", {});
		for (let attempt = 0; current.state !== "ready" && attempt < 20; attempt++)
			current = await runtime.call("refreshSidebarProjection", {});
		assert.equal(current.state, "ready");
		const anchor = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
		const result = await runtime.call("listSidebarWindow", {
			view: { kind: "recent" },
			position: { kind: "around", anchor },
			retainedScopes: [anchor, anchor],
		});
		assert.equal(result.kind, "window");
		if (result.kind !== "window") assert.fail("Expected the published conversation window");
		assert.deepEqual(
			result.items.map((item) => item.conversation),
			[conversation],
		);
		assert.equal(result.retained.eligible.length, 1);
		assert.equal(result.retained.eligible[0].placement, "inside");
		assert.deepEqual(result.retained.eligible[0].row.conversation, conversation);
		assert.deepEqual(parseResult("listSidebarWindow", result), result);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
