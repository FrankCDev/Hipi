import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ActivitySession } from "../../../apps/hipi-work-ui/src/features/tool-activities/activity-session.ts";
import { type AppClient, parseResult } from "../src/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { openRuntime } from "../src/node.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for deterministic faux task");
}

test("real faux save projects approval and artifact then cold read does not resume a provider", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-activity-runtime-"));
	await writeFile(join(directory, "note.txt"), "before");
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: directory,
		writable: true,
	});
	const files = authority.forAgent("owner");
	const before = await files.readText({ ...root, path: "note.txt" });
	const faux = fauxProvider({
		provider: "faux",
		api: "activity-test",
		models: [{ id: "faux", contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 100000,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const options = { models, model: { provider: "faux", modelId: "faux" }, agentFiles: () => files };
	let runtime = await openRuntime(join(directory, "store"), options);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "conversation",
			title: "Activity",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		await runtime.call("authorizeAgentContext", {
			...scope,
			requestId: "grant",
			rootId: root.rootId,
			pathPrefixes: [""],
			model: options.model,
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"hipi_files_save",
						{ rootId: root.rootId, path: "note.txt", text: "after", ifMatch: before.revision },
						{ id: "save" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Saved."),
		]);
		await runtime.call("submit", { ...scope, requestId: "submit", text: "Save fixture" });
		const pending = await until(async () => {
			const value = (await runtime.call("getToolActivities", scope)).items.find(
				(item) => item.approval?.status === "pending",
			);
			return value;
		});
		assert.equal(pending.toolResult, "unavailable");
		assert.equal(pending.effect, undefined);
		const approval = (await runtime.call("listToolApprovals", scope)).items[0];
		await runtime.call("decideToolApproval", {
			...scope,
			requestId: "approve",
			approvalId: approval.approvalId,
			expectedRevision: approval.revision,
			argumentsDigest: approval.argumentsDigest,
			contentDigest: approval.contentDigest,
			decision: "approve",
		});
		const completed = await until(async () => {
			const value = (await runtime.call("getToolActivities", scope)).items.find((item) => item.phase === "terminal");
			return value;
		});
		assert.equal(completed.activityId, pending.activityId);
		assert.equal(completed.toolResult, "success");
		assert.equal(completed.effect?.status, "confirmed");
		assert.equal(completed.artifact?.path, "note.txt");
		assert.equal(completed.artifact?.rootId, root.rootId);
		assert.equal(
			completed.artifact?.expectedRevision,
			(await files.readText({ ...root, path: "note.txt" })).revision,
		);
		await until(async () => {
			const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "submit" });
			return receipt?.execution === "done" ? receipt : undefined;
		});
		await runtime.close();
		const calls = faux.state.callCount;
		runtime = await openRuntime(join(directory, "store"), options);
		const cold = (await runtime.call("getToolActivities", scope)).items[0];
		assert.equal(cold.activityId, completed.activityId);
		assert.equal(cold.effect?.status, "confirmed");
		assert.equal(cold.outputTruncated, false);
		const output = parseResult(
			"getToolActivityText",
			await runtime.call("getToolActivityText", { ...scope, activityId: cold.activityId }),
		);
		assert.equal(output.retainedOutputOnly, true);
		assert.match(output.text, /confirmed/);
		assert.throws(() => parseResult("getToolActivityText", { ...output, retainedOutputOnly: false }), {
			code: "INVALID_REQUEST",
		});
		// Cross-layer regression: actual persisted, untruncated output must pass the UI read guard.
		// Mirror the JSON transport boundary, which omits absent optional cursor fields.
		const client: AppClient = {
			call: async (method, params, signal) =>
				parseResult(method, await runtime.call(method, JSON.parse(JSON.stringify(params)), signal)),
			observe: runtime.observe.bind(runtime),
		};
		const session = new ActivitySession(client, scope);
		session.activate();
		try {
			await session.page();
			await session.text(cold.activityId);
			assert.equal(session.snapshot().failed, false);
			assert.deepEqual(session.snapshot().text, output);
		} finally {
			session.dispose();
		}
		assert.equal(faux.state.callCount, calls);
	} finally {
		await runtime.close();
		await authority.close();
		await rm(directory, { recursive: true, force: true });
	}
});
