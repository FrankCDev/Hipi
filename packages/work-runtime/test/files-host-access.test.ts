import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/contracts.ts";
import { WorkRuntime } from "../src/core.ts";
import { createRuntimeFileHost } from "../src/files/host.ts";
import { deniedFeatureReads } from "./feature-port-fixture.ts";

test("file authorization uses a scoped catalog point lookup without paging or opening a Harness", async () => {
	let lookups = 0;
	const forbidden = async (): Promise<never> => {
		throw new Error("File authorization must not open a workspace or enumerate the directory");
	};
	const runtime = new WorkRuntime({
		...deniedFeatureReads,
		storeId: "store",
		getWorkspace: async ({ workspaceId }) => {
			lookups++;
			if (workspaceId === "missing") throw new AppError("NOT_FOUND");
			return { workspaceId: workspaceId === "mismatched" ? "different" : workspaceId, name: "Existing" };
		},
		getAgentCommandResult: forbidden,
		listModels: forbidden,
		getConversation: forbidden,
		getConversationCommandResult: forbidden,
		listWorkspaces: forbidden,
		listConversations: forbidden,
		openWorkspace: forbidden,
		close: async () => {},
	});
	const host = await createRuntimeFileHost(runtime, "principal");
	const files = host.authority.forPrincipal("principal");
	try {
		assert.deepEqual(await files.listRoots("later-page-workspace"), []);
		assert.equal(lookups, 1);
		await assert.rejects(files.listRoots("missing"), { code: "UNAUTHORIZED" });
		await assert.rejects(files.listRoots("mismatched"), { code: "UNAUTHORIZED" });
		const stranger = host.authority.forPrincipal("stranger");
		await assert.rejects(stranger.listRoots("later-page-workspace"), { code: "UNAUTHORIZED" });
		assert.equal(lookups, 3);
	} finally {
		await host.authority.close();
		await runtime.close();
	}
});
