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
test("artifact navigation opens a retained tab with original provenance and no destructive clear", () => {
	const actions: unknown[] = [];
	const navigate = artifactNavigation(
		scope,
		() => scope,
		{
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
		true,
		[
			{ workspaceId: scope.workspaceId, rootId: artifact.rootId, path: artifact.path },
			{ operationId: artifact.operationId, expectedRevision: artifact.expectedRevision },
		],
	]);
});
test("artifact navigation refuses old callbacks after either conversation or workspace changes", () => {
	let selected: Scope = scope;
	let mutations = 0;
	const navigate = artifactNavigation(
		scope,
		() => selected,
		{
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
	selected = { ...scope, conversationId: "another" };
	navigate(artifact);
	assert.equal(mutations, 0);
	selected = { ...scope, workspaceId: "another" };
	navigate(artifact);
	assert.equal(mutations, 0);
});
