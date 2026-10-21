import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type Frame, parseFrame } from "../../src/contracts.ts";
import { createFileAuthority } from "../../src/files/service.ts";
import { openRuntime } from "../../src/node.ts";
import { serveLoopback } from "../../src/transport-http.ts";
import { createHttpClient } from "../../src/transport-http-client.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Approval execution evidence not observed");
}

for (const reopen of [false, true])
	test(
		reopen
			? "SQLite reopen preserves exact committed tool anchors while paused; cancellation clears them"
			: "real approval matches current tool/task/submission and cannot follow a later reply",
		{ timeout: 15000 },
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "hipi-execution-approval-"));
			await writeFile(join(directory, "note.txt"), "original");
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
			const original = await files.readText({ ...root, path: "note.txt" });
			const faux = fauxProvider({
				provider: "faux",
				api: "hipi-test",
				models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
				tokensPerSecond: 100000,
			});
			const models = createModels();
			models.setProvider(faux.provider);
			const model = { provider: "faux", modelId: "faux-1" };
			const options = { models, model, agentFiles: () => files };
			let runtime = await openRuntime(join(directory, "store"), options);
			const origin = "http://127.0.0.1:4000";
			const server = await serveLoopback(runtime, { origin });
			let serverClosed = false;
			const client = createHttpClient({ ...server, origin });
			try {
				await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
				const created = await runtime.call("createConversation", {
					workspaceId: "work",
					requestId: "create",
					title: "Approval",
				});
				const scope = { workspaceId: "work", conversationId: created.conversationId };
				await runtime.call("authorizeAgentContext", {
					...scope,
					requestId: "grant",
					rootId: root.rootId,
					pathPrefixes: [""],
					model,
					expiresAt: Date.now() + 60000,
					disclosureVersion: 1,
				});
				faux.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall(
								"hipi_files_save",
								{ rootId: root.rootId, path: "note.txt", text: "replacement", ifMatch: original.revision },
								{ id: "save" },
							),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Save rejected."),
					fauxAssistantMessage("Unrelated reply."),
				]);
				const frames: Frame[] = [];
				const watch = await client.observe(scope, (frame) => {
					frames.push(parseFrame(frame));
				});
				try {
					await runtime.call("submit", { ...scope, requestId: "first", text: "Propose edit" });
					const approval = await until(
						async () => (await runtime.call("listPendingToolApprovals", scope)).items[0],
					);
					assert.equal(approval.status, "pending");
					const live = await until(
						async () =>
							frames.findLast((frame) =>
								frame.snapshot.execution?.tools.items.some(
									(tool) => tool.taskId === approval.taskId && tool.callId === approval.callId,
								),
							)?.snapshot.execution,
					);
					assert.deepEqual(live.submissionIds, approval.submissionIds);
					assert.equal(live.tools.active, 1);
					assert.equal(live.tools.items[0]?.status, "pending");
					assert.ok(live.tools.items[0]?.anchor);
					const cold = await runtime.call("snapshot", scope);
					assert.deepEqual(cold.execution?.tools.items[0]?.anchor, live.tools.items[0]?.anchor);
					if (reopen) {
						await watch.dispose();
						await server.close();
						serverClosed = true;
						await runtime.close();
						runtime = await openRuntime(join(directory, "store"), { ...options, resume: false });
						const paused = await runtime.call("snapshot", scope);
						assert.equal(paused.running, false);
						assert.deepEqual(paused.execution?.tools.items[0]?.anchor, live.tools.items[0]?.anchor);
						assert.equal(paused.execution?.ownerTaskId, live.ownerTaskId);
						await runtime.call("cancelExecution", scope);
						await runtime.call("continueWorkspace", { workspaceId: "work" });
						await until(async () => (!(await runtime.call("snapshot", scope)).execution ? true : undefined));
						return;
					}
					// A pending approval is NOT represented by a fabricated "waiting" task phase.
					assert.equal(live.generation, undefined);
					await runtime.call("decideToolApproval", {
						...scope,
						requestId: "reject",
						approvalId: approval.approvalId,
						expectedRevision: approval.revision,
						argumentsDigest: approval.argumentsDigest,
						contentDigest: approval.contentDigest,
						decision: "reject",
					});
					await until(async () =>
						(await runtime.call("getReceipt", { workspaceId: "work", requestId: "first" }))?.execution === "done"
							? true
							: undefined,
					);
					const boundary = frames.length;
					await runtime.call("submit", { ...scope, requestId: "second", text: "New request" });
					await until(async () =>
						(await runtime.call("getReceipt", { workspaceId: "work", requestId: "second" }))?.execution === "done"
							? true
							: undefined,
					);
					const second = frames
						.slice(boundary)
						.flatMap((frame) => (frame.snapshot.execution ? [frame.snapshot.execution] : []));
					assert.ok(second.length > 0);
					assert.ok(
						second.every(
							(execution) => !execution.submissionIds.some((id) => approval.submissionIds.includes(id)),
						),
					);
					assert.ok(
						second.every((execution) => execution.tools.items.every((tool) => tool.taskId !== approval.taskId)),
					);
					assert.equal((await runtime.call("snapshot", scope)).execution, undefined);
				} finally {
					await watch.dispose();
				}
			} finally {
				if (!serverClosed) await server.close();
				await runtime.close();
				await authority.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
