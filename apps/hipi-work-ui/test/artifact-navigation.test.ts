import assert from "node:assert/strict";
import type { Scope, ToolActivity } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { artifactNavigation } from "../src/features/workbench/artifact-navigation.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const artifact: NonNullable<ToolActivity["artifact"]> = {
	rootId: "root",
	path: "result.txt",
	operationId: "operation",
	status: "observed_match",
	expectedRevision: "a".repeat(64),
};
test("artifact navigation preserves dirty input when leaving is cancelled", () => {
	let input = "unsaved input";
	let pending: (() => void) | undefined;
	const opened: unknown[] = [];
	const navigate = artifactNavigation(
		scope,
		() => scope,
		(action) => {
			pending = action;
		},
		{
			clear: () => {
				input = "";
			},
			openArtifact: async (...args) => {
				opened.push(args);
			},
		},
		{
			setOpen: () => {
				opened.push("panel");
			},
		},
	);
	navigate(artifact);
	assert.ok(pending);
	pending = undefined;
	assert.equal(input, "unsaved input");
	assert.deepEqual(opened, []);
});
test("artifact navigation refuses old callbacks after either conversation or workspace changes", () => {
	let selected: Scope = scope;
	let pending: (() => void) | undefined;
	let mutations = 0;
	const navigate = artifactNavigation(
		scope,
		() => selected,
		(action) => {
			pending = action;
		},
		{
			clear: () => {
				mutations++;
			},
			openArtifact: async () => {
				mutations++;
			},
		},
		{
			setOpen: () => {
				mutations++;
			},
		},
	);
	navigate(artifact);
	selected = { ...scope, conversationId: "another" };
	pending?.();
	assert.equal(mutations, 0);
	selected = scope;
	navigate(artifact);
	selected = { ...scope, workspaceId: "another" };
	pending?.();
	assert.equal(mutations, 0);
});
test("confirmed artifact navigation opens only the selected current file with original provenance", () => {
	const actions: unknown[] = [];
	const navigate = artifactNavigation(
		scope,
		() => scope,
		(action) => action(),
		{
			clear: () => {
				actions.push("clear");
			},
			openArtifact: async (...args) => {
				actions.push(args);
			},
		},
		{
			setOpen: (open) => {
				actions.push(open);
			},
		},
	);
	navigate(artifact);
	assert.deepEqual(actions, [
		"clear",
		true,
		[
			{ workspaceId: scope.workspaceId, rootId: artifact.rootId, path: artifact.path },
			{ operationId: artifact.operationId, expectedRevision: artifact.expectedRevision },
		],
	]);
});
