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
					fauxToolCall("hipi_files_read", { rootId: root.rootId, path: "note.txt" }, { id: "read" }),
					fauxToolCall("hipi_files_list", { rootId: root.rootId, path: "" }, { id: "list" }),
				],
				{ stopReason: "toolUse" },
			),
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
		assert.equal(pending.fileSummary, undefined);
		const liveSnapshot = await runtime.call("snapshot", scope);
		const slot = liveSnapshot.execution?.tools.items.find((item) => item.taskId === pending.taskId);
		assert.equal(slot?.callId, pending.callId);
		assert.ok(slot?.taskId);
		const exact = await runtime.call("getToolActivities", {
			...scope,
			selector: { kind: "tasks", taskIds: [slot.taskId, "9007199254740991"] },
		});
		assert.deepEqual(
			exact.items.map((item) => item.activityId),
			[pending.activityId],
		);
		assert.deepEqual(exact.unavailableTaskIds, ["9007199254740991"]);
		assert.ok(pending.anchor);
		const messageId = `${pending.anchor.assistantEntryId}_${pending.anchor.modelIndex}`;
		const toolMessage = liveSnapshot.messages.find((item) => item.id === messageId);
		assert.deepEqual(toolMessage?.toolCalls, {
			items: [{ contentIndex: pending.anchor.contentIndex, callId: "save", name: "hipi_files_save" }],
			total: 1,
		});
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
			const value = (await runtime.call("getToolActivities", scope)).items.find(
				(item) => item.phase === "terminal" && item.taskId === pending.taskId,
			);
			return value;
		});
		assert.equal(completed.activityId, pending.activityId);
		assert.equal(completed.toolResult, "success");
		assert.equal(completed.effect?.status, "confirmed");
		assert.equal(completed.artifact?.path, "note.txt");
		assert.equal(completed.artifact?.rootId, root.rootId);
		assert.deepEqual(completed.fileSummary, {
			version: 1,
			target: { rootId: root.rootId, path: "note.txt" },
			kind: "save",
			partial: false,
			operationId: completed.effect?.operationId,
		});
		assert.equal(
			completed.artifact?.expectedRevision,
			(await files.readText({ ...root, path: "note.txt" })).revision,
		);
		await until(async () => {
			const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "submit" });
			return receipt?.execution === "done" ? receipt : undefined;
		});
		// A later cancelled round reuses the provider call ID, but must keep its own durable message/task identity.
		const currentFile = await files.readText({ ...root, path: "note.txt" });
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"hipi_files_save",
						{
							rootId: root.rootId,
							path: "note.txt",
							text: "never approved",
							ifMatch: currentFile.revision,
						},
						{ id: "save" },
					),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await runtime.call("submit", { ...scope, requestId: "cancel-submit", text: "Prepare another edit" });
		const cancelledActivity = await until(async () => {
			const value = (await runtime.call("getToolActivities", scope)).items.find(
				(item) => item.approval?.status === "pending" && item.taskId !== pending.taskId,
			);
			return value;
		});
		assert.ok(cancelledActivity.anchor);
		const cancelledMessageId = `${cancelledActivity.anchor.assistantEntryId}_${cancelledActivity.anchor.modelIndex}`;
		assert.notEqual(cancelledMessageId, messageId);
		await runtime.call("cancelExecution", scope);
		await until(async () => {
			const value = await runtime.call("snapshot", scope);
			return !value.running && !value.execution ? value : undefined;
		});
		await runtime.close();
		const calls = faux.state.callCount;
		runtime = await openRuntime(join(directory, "store"), options);
		const cold = (await runtime.call("getToolActivities", scope)).items.find(
			(item) => item.activityId === completed.activityId,
		)!;
		assert.equal(cold.activityId, completed.activityId);
		assert.equal(cold.effect?.status, "confirmed");
		assert.equal(cold.outputTruncated, false);
		assert.deepEqual(cold.fileSummary, completed.fileSummary);
		const coldSnapshot = await runtime.call("snapshot", scope);
		assert.equal(coldSnapshot.execution, undefined);
		assert.equal(
			coldSnapshot.messages.find((item) => item.id === cancelledMessageId)?.toolCalls?.items[0]?.callId,
			"save",
		);
		const cancelledPage = await runtime.call("getToolActivities", {
			...scope,
			selector: { kind: "message", messageId: cancelledMessageId },
		});
		assert.deepEqual(
			cancelledPage.items.map((item) => item.taskId),
			[cancelledActivity.taskId],
		);
		assert.notEqual(cancelledPage.items[0]?.toolResult, "success");
		assert.equal(cancelledPage.items[0]?.fileSummary, undefined);
		assert.deepEqual(coldSnapshot.messages.find((item) => item.id === messageId)?.toolCalls, toolMessage?.toolCalls);
		const historical = await runtime.call("getToolActivities", {
			...scope,
			selector: { kind: "message", messageId, contentIndex: pending.anchor.contentIndex },
		});
		assert.equal(historical.items[0]?.activityId, cold.activityId);
		assert.equal(historical.unavailableTaskIds, undefined);
		const output = parseResult(
			"getToolActivityText",
			await runtime.call("getToolActivityText", { ...scope, activityId: cold.activityId }),
		);
		assert.equal(output.retainedOutputOnly, true);
		assert.equal(output.presentation?.result.kind, "save");
		assert.equal(output.presentation?.target.path, "note.txt");
		const activities = await runtime.call("getToolActivities", scope);
		for (const [name, kind] of [
			["hipi_files_read", "read"],
			["hipi_files_list", "directory"],
		] as const) {
			const activity = activities.items.find((item) => item.toolName === name);
			assert.ok(activity);
			assert.deepEqual(activity.fileSummary, {
				version: 1,
				target: { rootId: root.rootId, path: kind === "directory" ? "" : "note.txt" },
				kind,
				partial: false,
			});
			const page = parseResult(
				"getToolActivityText",
				await runtime.call("getToolActivityText", { ...scope, activityId: activity.activityId }),
			);
			assert.equal(page.presentation?.result.kind, kind);
			if (page.presentation?.result.kind === "read") assert.equal(page.presentation.result.text, "before");
			if (page.presentation?.result.kind === "directory")
				assert.ok(page.presentation.result.entries.some((item) => item.name === "note.txt"));
		}
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
			assert.ok(session.snapshot().page?.items.some((item) => item.activityId === cold.activityId));
			assert.deepEqual(
				session.snapshot().page?.items.find((item) => item.activityId === cold.activityId)?.fileSummary,
				completed.fileSummary,
			);
			assert.ok(cold.taskId);
			const exact = await connection.client.call("getToolActivities", {
				...scope,
				selector: { kind: "tasks", taskIds: [cold.taskId] },
			});
			assert.deepEqual(exact.items[0]?.fileSummary, completed.fileSummary);
			assert.equal(session.snapshot().text, undefined);
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
