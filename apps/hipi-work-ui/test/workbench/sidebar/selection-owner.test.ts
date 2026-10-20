import assert from "node:assert/strict";
import { test } from "vitest";
import {
	resolveSidebarAlias,
	type SidebarAliasCandidate,
	type SidebarLocation,
	sidebarLocationsEqual,
} from "../../../src/features/workbench/sidebar/selection-owner.ts";

const pinned: SidebarLocation = Object.freeze({ kind: "pinned" });
const recent: SidebarLocation = Object.freeze({ kind: "recent" });
const workspace: SidebarLocation = Object.freeze({ kind: "workspace", workspaceId: "workspace" });

function alias(id: string, location: SidebarLocation, eligible = true): SidebarAliasCandidate {
	return Object.freeze({ id, location, eligible });
}

test("the preferred eligible location wins over earlier aliases and the previous owner", () => {
	const candidates = [alias("recent", recent), alias("workspace", workspace), alias("pinned", pinned)];
	assert.equal(resolveSidebarAlias(candidates, pinned, "recent"), "pinned");
	assert.equal(resolveSidebarAlias(candidates, workspace, "pinned"), "workspace");
	assert.equal(resolveSidebarAlias(candidates, recent, "workspace"), "recent");
});

test("without a preferred location the first eligible alias wins in the supplied DOM order", () => {
	const hidden = alias("hidden", pinned, false);
	const first = alias("first", workspace);
	const second = alias("second", recent);
	assert.equal(resolveSidebarAlias([hidden, first, second], null, "second"), "first");
	assert.equal(resolveSidebarAlias([hidden, second, first], null, "first"), "second");
});

test("an absent or ineligible preferred location falls back without keeping an eligible previous owner", () => {
	const candidates = [alias("hidden", pinned, false), alias("first", recent), alias("previous", workspace)];
	assert.equal(resolveSidebarAlias(candidates, pinned, "previous"), "first");
	assert.equal(
		resolveSidebarAlias(candidates, { kind: "workspace", workspaceId: "unregistered" }, "previous"),
		"first",
	);
});

test("multiple aliases in the preferred location use current DOM order rather than previous ownership", () => {
	const first = alias("first", pinned);
	const second = alias("second", pinned);
	const fallback = alias("fallback", recent);
	assert.equal(resolveSidebarAlias([fallback, first, second], pinned, "second"), "first");
	assert.equal(resolveSidebarAlias([fallback, second, first], pinned, "first"), "second");
});

test("collapse falls back and re-expansion restores the unchanged preferred location", () => {
	const preferred = Object.freeze({ kind: "workspace", workspaceId: "workspace" } as const);
	const fallback = alias("fallback", pinned);
	let owner = resolveSidebarAlias([fallback, alias("preferred", preferred)], preferred, null);
	assert.equal(owner, "preferred");
	owner = resolveSidebarAlias([fallback, alias("preferred", preferred, false)], preferred, owner);
	assert.equal(owner, "fallback");
	owner = resolveSidebarAlias([fallback, alias("preferred", preferred)], preferred, owner);
	assert.equal(owner, "preferred");
	assert.deepEqual(preferred, { kind: "workspace", workspaceId: "workspace" });
});

test("when every alias is ineligible only a still-registered previous owner is retained", () => {
	const candidates = [alias("pinned", pinned, false), alias("recent", recent, false)];
	assert.equal(resolveSidebarAlias(candidates, pinned, "recent"), "recent");
	assert.equal(resolveSidebarAlias(candidates, recent, "pinned"), "pinned");
	assert.equal(resolveSidebarAlias(candidates, pinned, null), null);
});

test("unregistering the last owner clears its stale ID instead of choosing another hidden alias", () => {
	const remaining = alias("remaining", recent, false);
	const previous = alias("previous", pinned, false);
	assert.equal(resolveSidebarAlias([previous, remaining], pinned, "previous"), "previous");
	assert.equal(resolveSidebarAlias([remaining], pinned, "previous"), null);
	assert.equal(resolveSidebarAlias([], pinned, "previous"), null);
	assert.equal(resolveSidebarAlias([], null, null), null);
});

test("a newly eligible alias replaces a retained hidden owner", () => {
	const previous = alias("previous", pinned, false);
	const next = alias("next", recent, false);
	let owner = resolveSidebarAlias([previous, next], pinned, "previous");
	assert.equal(owner, "previous");
	owner = resolveSidebarAlias([previous, { ...next, eligible: true }], pinned, owner);
	assert.equal(owner, "next");
});

test("workspace preference requires the exact workspace ID, not only a matching location kind", () => {
	const other = alias("other", { kind: "workspace", workspaceId: "workspace-other" });
	const matching = alias("matching", workspace);
	assert.equal(resolveSidebarAlias([other, matching], workspace, null), "matching");
	assert.equal(resolveSidebarAlias([alias("fallback", recent), other], workspace, null), "fallback");
});

test("resolution leaves registered candidates, their order, and the preferred location unchanged", () => {
	const candidates = Object.freeze([alias("recent", recent), alias("pinned", pinned)]);
	assert.equal(resolveSidebarAlias(candidates, pinned, "recent"), "pinned");
	assert.deepEqual(candidates, [
		{ id: "recent", location: { kind: "recent" }, eligible: true },
		{ id: "pinned", location: { kind: "pinned" }, eligible: true },
	]);
});

test.each<{ left: SidebarLocation; right: SidebarLocation; equal: boolean }>([
	{ left: pinned, right: { kind: "pinned" }, equal: true },
	{ left: recent, right: { kind: "recent" }, equal: true },
	{ left: workspace, right: { kind: "workspace", workspaceId: "workspace" }, equal: true },
	{ left: pinned, right: recent, equal: false },
	{ left: pinned, right: workspace, equal: false },
	{ left: recent, right: workspace, equal: false },
	{ left: workspace, right: { kind: "workspace", workspaceId: "workspace-other" }, equal: false },
	{ left: workspace, right: { kind: "workspace", workspaceId: "Workspace" }, equal: false },
])("location equality is exact and symmetric: $left / $right", ({ left, right, equal }) => {
	assert.equal(sidebarLocationsEqual(left, right), equal);
	assert.equal(sidebarLocationsEqual(right, left), equal);
});
