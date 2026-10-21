import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { decode, encode } from "../../../apps/hipi-work-desktop/src/ipc/protocol.ts";
import { HostConnection } from "../../../apps/hipi-work-desktop/src/runtime/connection.ts";
import { createRuntimeRouter } from "../../../apps/hipi-work-desktop/src/runtime/router.ts";
import { createDesktopClient } from "../../../apps/hipi-work-ui/src/app/desktop-client.ts";
import { ActivitySession } from "../../../apps/hipi-work-ui/src/features/tool-activities/activity-session.ts";
import { parseRequest, parseResult } from "../src/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { openRuntime } from "../src/node.ts";

function desktopConnection(runtime: Awaited<ReturnType<typeof openRuntime>>) {
	const tasks = new Set<Promise<void>>();
	const host = new HostConnection("activity", (raw) => {
		const task = router.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => host.close());
	});
	const router = createRuntimeRouter(runtime, "activity", (raw) => host.receive(raw));
	const client = createDesktopClient({
		// Match preload: validate before JSON encoding. Serializing params first masks undefined-field bugs.
		request: (raw) => host.call(decode(encode(parseRequest(raw)))).result,
		subscribe: () => {
			throw new Error("This activity regression does not subscribe");
		},
	});
	return {
		client,
		async close() {
			host.close();
			await Promise.all(tasks);
		},
	};
}

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
		const initialConnection = desktopConnection(runtime);
		const initialSession = new ActivitySession(initialConnection.client, scope);
		initialSession.activate();
		try {
			await initialSession.page();
			assert.equal(initialSession.snapshot().failed, false);
			assert.deepEqual(initialSession.snapshot().page, await runtime.call("getToolActivities", scope));
			assert.deepEqual(initialSession.snapshot().page?.items, []);
			const nextCursor = initialSession.snapshot().page?.nextCursor;
			if (nextCursor) {
				await initialSession.page(nextCursor);
				assert.equal(initialSession.snapshot().failed, false);
				assert.deepEqual(
					initialSession.snapshot().page,
					await runtime.call("getToolActivities", { ...scope, cursor: nextCursor }),
				);
			}
			await initialSession.page("invalid-cursor");
			assert.equal(initialSession.snapshot().failed, true);
			await initialSession.page();
			assert.equal(initialSession.snapshot().failed, false);
		} finally {
			initialSession.dispose();
			await initialConnection.close();
		}
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
		// Cross-layer regression: actual persisted output must pass desktop validation before serialization.
		const connection = desktopConnection(runtime);
		const session = new ActivitySession(connection.client, scope);
		session.activate();
		try {
			await session.page();
			assert.equal(session.snapshot().failed, false);
			assert.equal(session.snapshot().page?.items[0]?.activityId, cold.activityId);
			await session.text(cold.activityId);
			assert.equal(session.snapshot().failed, false);
			assert.deepEqual(session.snapshot().text, output);
		} finally {
			session.dispose();
			await connection.close();
		}
		assert.equal(faux.state.callCount, calls);
	} finally {
		await runtime.close();
		await authority.close();
		await rm(directory, { recursive: true, force: true });
	}
});
