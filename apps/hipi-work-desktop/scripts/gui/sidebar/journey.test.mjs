import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	assertAliasSelection,
	assertHomeDraftContext,
	assertSidebarAcceptance,
	assertSidebarState,
	expectedPinnedPreview,
} from "./journey.mjs";
import { defaultRoleEntry, sidebarWorkspaceIds } from "./manifest.mjs";

const seed = {
	workspaceIds: [...sidebarWorkspaceIds],
	defaultWorkspaceId: sidebarWorkspaceIds[0],
	handshake: { storeId: "owned-store", protocolVersion: 9 },
	pins: [
		{ workspaceId: sidebarWorkspaceIds[1], conversationId: "same-a" },
		{ workspaceId: sidebarWorkspaceIds[1], conversationId: "same-b" },
		{ workspaceId: sidebarWorkspaceIds[2], conversationId: "same-c" },
	],
};
const state = () => ({
	sections: ["pinned", "recent", "projects"],
	collapsed: { pinned: false, recent: true, projects: false },
	projects: [sidebarWorkspaceIds[2], sidebarWorkspaceIds[1]],
	pins: structuredClone(seed.pins),
	draft: "synthetic unsent draft",
	messages: [{ id: "message-1", text: "synthetic history" }],
	dragging: false,
	overlay: false,
});

test("alias oracle rejects duplicate highlights, wrong location and remounted conversation owners", () => {
	const scope = seed.pins[0];
	const value = {
		selected: [{ ...scope, location: "workspace" }],
		draft: "Unsent alias text",
		samePanel: true,
		sameComposer: true,
		sameHistory: true,
	};
	assertAliasSelection(value, scope, "workspace", value.draft);
	for (const change of [
		(item) => item.selected.push({ ...scope, location: "recent" }),
		(item) => {
			item.selected[0].location = "recent";
		},
		(item) => {
			item.selected[0].workspaceId = "foreign";
		},
		(item) => {
			item.draft = "";
		},
		(item) => {
			item.samePanel = false;
		},
		(item) => {
			item.sameComposer = false;
		},
		(item) => {
			item.sameHistory = false;
		},
	]) {
		const changed = structuredClone(value);
		change(changed);
		assert.throws(() => assertAliasSelection(changed, scope, "workspace", value.draft));
	}
});

test("New chat context oracle requires exact project, retained text and stable home input", () => {
	const value = { projects: ["project-a"], conversations: 0, draft: "Shared unsent text", sameInput: true };
	assertHomeDraftContext(value, "project-a", value.draft);
	assertHomeDraftContext({ ...value, projects: [] }, null, value.draft);
	assertHomeDraftContext({ ...value, sameInput: false }, "project-a", value.draft, false);
	assert.throws(() =>
		assertHomeDraftContext({ ...value, draft: "wrong", sameInput: false }, "project-a", value.draft, false),
	);
	for (const changed of [
		{ ...value, projects: ["project-b"] },
		{ ...value, projects: [] },
		{ ...value, conversations: 1 },
		{ ...value, draft: "" },
		{ ...value, sameInput: false },
	])
		assert.throws(() => assertHomeDraftContext(changed, "project-a", value.draft));
});

test("logical alias oracle cannot substitute the physical workspace for project identity", () => {
	const scope = seed.pins[0];
	const value = {
		selected: [{ ...scope, location: "project", projectId: "logical-project" }],
		draft: "Keep text",
		samePanel: true,
		sameComposer: true,
		sameHistory: true,
	};
	assertAliasSelection(value, scope, "project", value.draft, "logical-project");
	assert.throws(() => assertAliasSelection(value, scope, "project", value.draft, scope.workspaceId));
	assert.throws(() => assertAliasSelection(value, scope, "project", value.draft));
});

test("sidebar oracle rejects wrong canonical scope despite identical visible title", () => {
	assertSidebarState(state(), seed);
	for (const change of [
		(value) => {
			value.pins[0].workspaceId = sidebarWorkspaceIds[2];
		},
		(value) => {
			value.pins[1] = value.pins[0];
		},
		(value) => {
			value.projects[0] = seed.defaultWorkspaceId;
		},
		(value) => {
			value.sections[0] = "recent";
		},
		(value) => {
			value.dragging = true;
		},
		(value) => {
			value.overlay = true;
		},
	]) {
		const value = state();
		change(value);
		assert.throws(() => assertSidebarState(value, seed));
	}
});

test("cold acceptance requires completed native evidence and exact local/data restoration", () => {
	const first = {
		nativeInput: true,
		fixtureSetupOnly: true,
		actions: Array.from({ length: 16 }, (_, n) => ({ name: `native-${n}` })),
		warmHover: { frames: 20 },
		autoscroll: { observed: true },
		final: state(),
	};
	const reopened = { final: state(), coldRestored: true };
	assertSidebarAcceptance({ first, reopened });
	for (const change of [
		(value) => {
			value.final.draft = "";
		},
		(value) => {
			value.final.pins.reverse();
		},
		(value) => {
			value.final.collapsed.recent = false;
		},
		(value) => {
			value.final.projects.reverse();
		},
		(value) => {
			value.final.messages[0].id = "replacement";
		},
		(value) => {
			value.coldRestored = false;
		},
	]) {
		const changed = structuredClone(reopened);
		change(changed);
		assert.throws(() => assertSidebarAcceptance({ first, reopened: changed }));
	}
	assert.throws(() => assertSidebarAcceptance({ first: { ...first, actions: [] }, reopened }));
	assert.throws(() => assertSidebarAcceptance({ first: { ...first, nativeInput: false }, reopened }));
	assert.throws(() => assertSidebarAcceptance({ first: { ...first, warmHover: { frames: 0 } }, reopened }));
});

test("fixture writes only the verified store-scoped completed default role, never pending recovery", () => {
	const entry = defaultRoleEntry(seed);
	assert.deepEqual(entry, {
		version: 1,
		storeId: "owned-store",
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({
			version: 1,
			role: "default-chat-workspace",
			workspaceId: "sidebar-chats",
		}),
	});
	assert.deepEqual(defaultRoleEntry({ ...seed, handshake: { ...seed.handshake, protocolVersion: 10 } }), entry);
	for (const changed of [
		{ ...seed, defaultWorkspaceId: "other" },
		{ ...seed, workspaceIds: ["other"] },
		{ ...seed, handshake: { ...seed.handshake, storeId: "../escape" } },
	])
		assert.throws(() => defaultRoleEntry(changed));
});

test("hover expectations come from seeded canonical data, not the card being qualified", () => {
	const snapshot = {
		workspaces: [
			{ workspaceId: "project-a", name: "Actual project A" },
			{ workspaceId: "project-b", name: "Actual project B" },
		],
		conversations: [
			{
				conversation: {
					workspaceId: "project-a",
					conversationId: "same-id",
					title: "Same visible title",
					createdAt: 1000,
				},
			},
			{
				conversation: {
					workspaceId: "project-b",
					conversationId: "same-id",
					title: "Same visible title",
					createdAt: 2000,
				},
			},
		],
	};
	const expected = expectedPinnedPreview({ snapshot }, { workspaceId: "project-b", conversationId: "same-id" });
	assert.deepEqual(expected.metadata.created, ["1970-01-01T00:00:02.000Z"]);
	assert.deepEqual(expected.metadata.workspaces, ["Actual project B"]);
	assert.throws(() => expectedPinnedPreview({ snapshot }, { workspaceId: "wrong", conversationId: "same-id" }));
});

test("independent sidebar runner precedes font/Settings GUI flow and always retains evidence", async () => {
	const workflow = await readFile(
		new URL("../../../../../.github/workflows/hipi-work-ci.yml", import.meta.url),
		"utf8",
	);
	const sidebar = workflow.indexOf("id: sidebar\n");
	assert.ok(sidebar > workflow.indexOf("scripts/smoke-packaged.mjs"));
	assert.ok(sidebar < workflow.indexOf("id: gui_smoke\n"));
	assert.match(workflow, /always\(\) && steps\.sidebar\.outcome != 'skipped'/);
	assert.match(workflow, /permissions:\n {2}contents: read/);
	const journey = await readFile(new URL("./journey.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(
		journey,
		/dispatchEvent|new (?:MouseEvent|PointerEvent|KeyboardEvent)|selectEnglish|settingsHarness/,
	);
	assert.match(journey, /Input\.dispatchMouseEvent/);
	assert.match(journey, /Input\.dispatchKeyEvent/);
});
