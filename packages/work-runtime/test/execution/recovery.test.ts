import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Frame, parseFrame, parseSnapshot } from "../../src/contracts.ts";
import { openRuntime } from "../../src/node.ts";
import { deterministicModels } from "../../src/testing.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Execution evidence not observed");
}

test(
	"SQLite reopen retains execution correlation while paused; cancel clears it without replaying the input",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-execution-"));
		const options = {
			model: { provider: "faux", modelId: "faux-1" },
			models: deterministicModels(1),
			credentials: { status: async () => "configured" as const, get: async () => "fictional" },
		};
		let runtime = await openRuntime(directory, options);
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
			const conversation = await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: "create",
				title: "Execution",
			});
			const scope = { workspaceId: "work", conversationId: conversation.conversationId };
			await runtime.call("submit", { ...scope, requestId: "input", text: "Keep this request identity" });
			const before = await until(async () => {
				const value = await runtime.call("snapshot", scope);
				return value.execution?.generation ? value : undefined;
			});
			const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "input" });
			assert.deepEqual(before.execution?.submissionIds, [receipt?.submissionId]);
			await runtime.close();
			runtime = await openRuntime(directory, { ...options, resume: true });
			const paused = parseSnapshot(await runtime.call("snapshot", scope));
			assert.equal(paused.running, false);
			assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
			assert.equal(paused.execution?.ownerTaskId, before.execution?.ownerTaskId);
			assert.deepEqual(paused.execution?.submissionIds, before.execution?.submissionIds);
			const frames: Frame[] = [];
			const watch = await runtime.observe(scope, (frame) => {
				frames.push(parseFrame(frame));
			});
			try {
				await until(async () => frames[0]);
				assert.equal(frames[0]?.snapshot.running, false);
				assert.equal(frames[0]?.snapshot.execution?.ownerTaskId, paused.execution?.ownerTaskId);
				await runtime.call("cancelExecution", scope);
				await runtime.call("continueWorkspace", { workspaceId: "work" });
				await until(async () => {
					const value = await runtime.call("snapshot", scope);
					return !value.execution ? value : undefined;
				});
				const cancelled = await runtime.call("getReceipt", { workspaceId: "work", requestId: "input" });
				assert.equal(cancelled?.submissionId, receipt?.submissionId);
				assert.equal(cancelled?.execution, "unanswered");
			} finally {
				await watch.dispose();
			}
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
