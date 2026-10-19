import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialState, Scope } from "../src/contracts.ts";
import { PROTOCOL_VERSION, parseRequest, parseResult } from "../src/contracts.ts";
import { openRuntime } from "../src/node.ts";
import { deterministicModels } from "../src/testing.ts";

const model = { provider: "faux", modelId: "faux-1" };
async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition timed out");
}
test("shared model protocol rejects secrets and accepts punctuated model identifiers", () => {
	const reference = { provider: "openai", modelId: "family/model.v1" };
	assert.deepEqual(
		parseRequest({
			version: PROTOCOL_VERSION,
			method: "createConversation",
			params: { workspaceId: "w", requestId: "create-protocol", title: "t", model: reference },
		}).params,
		{ workspaceId: "w", requestId: "create-protocol", title: "t", model: reference },
	);
	assert.throws(() => parseRequest({ version: PROTOCOL_VERSION, method: "listModels", params: { apiKey: "secret" } }));
	assert.throws(() =>
		parseResult("listModels", {
			models: [],
			providers: [{ provider: "openai", name: "OpenAI", credentialState: "configured", apiKey: "secret" }],
		}),
	);
	assert.throws(() =>
		parseResult("getConversationModel", { model, credentialState: "verified", executionState: "ready" }),
	);
	assert.equal(
		parseResult("cancelExecution", { model, credentialState: "missing", executionState: "cancellation_pending" })
			.executionState,
		"cancellation_pending",
	);
	assert.equal(
		parseResult("getReceipt", {
			workspaceId: "w",
			conversationId: "c",
			requestId: "r",
			receiptId: "receipt",
			state: "cancelled",
		})?.state,
		"cancelled",
	);
});
test("model stays fixed across defaults; missing credentials reject before admission; historical workspace requires explicit resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-model-"));
	let status: CredentialState = "missing";
	const credentials = {
		async status() {
			return status;
		},
		async get() {
			return status === "configured" ? "fictional-sentinel" : undefined;
		},
	};
	let interrupted = false;
	let runtime = await openRuntime(directory, {
		models: deterministicModels(1),
		credentials,
		failpoint: async (point) => {
			if (point === "after_accept") {
				interrupted = true;
				throw new Error("accepted interruption");
			}
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		await assert.rejects(
			runtime.call("createConversation", { requestId: "create-1", workspaceId: "work", title: "No implicit model" }),
			{
				code: "MODEL_UNAVAILABLE",
			},
		);
		const conversation = await runtime.call("createConversation", {
			requestId: "create-2",
			workspaceId: "work",
			title: "Fixed",
			model,
		});
		const scope: Scope = { workspaceId: "work", conversationId: conversation.conversationId };
		assert.equal((await runtime.call("getConversationModel", scope)).credentialState, "missing");
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "first", text: "Hello" }), {
			code: "CREDENTIAL_REQUIRED",
		});
		assert.equal(await runtime.call("getReceipt", { workspaceId: "work", requestId: "first" }), null);
		status = "configured";
		await assert.rejects(
			runtime.call("submit", { ...scope, requestId: "first", text: "Hello" }),
			/accepted interruption/,
		);
		assert.equal(interrupted, true);
		await runtime.close();
		runtime = await openRuntime(directory, {
			models: deterministicModels(200),
			credentials,
			model: { provider: "other", modelId: "different" },
			resume: true,
		});
		assert.deepEqual((await runtime.call("getConversationModel", scope)).model, model);
		assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
		const second = await runtime.call("createConversation", {
			requestId: "create-3",
			workspaceId: "work",
			title: "New conversation",
			model,
		});
		await assert.rejects(
			runtime.call("submit", {
				workspaceId: "work",
				conversationId: second.conversationId,
				requestId: "second",
				text: "Do not resume old work",
			}),
			{ code: "RESUME_REQUIRED" },
		);
		await assert.rejects(runtime.call("cancelExecution", { ...scope, conversationId: "missing" }), {
			code: "NOT_FOUND",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal((await runtime.call("getReceipt", { workspaceId: "work", requestId: "first" }))?.state, "accepted");
		status = "locked";
		await assert.rejects(runtime.call("continueWorkspace", { workspaceId: "work" }), { code: "CREDENTIAL_REQUIRED" });
		assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
		status = "configured";
		await runtime.call("continueWorkspace", { workspaceId: "work" });
		await until(
			async () =>
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "first" }))?.execution === "done",
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
test("execution cancel waits for PI idle and leaves accepted output distinguishable from completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-cancel-"));
	const runtime = await openRuntime(directory, { models: deterministicModels(1), model });
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const created = await runtime.call("createConversation", {
			requestId: "create-4",
			workspaceId: "work",
			title: "Cancel",
		});
		const scope = { workspaceId: "work", conversationId: created.conversationId };
		await runtime.call("submit", { ...scope, requestId: "cancel", text: "Slow" });
		await until(async () => (await runtime.call("snapshot", scope)).running);
		assert.equal((await runtime.call("cancelExecution", scope)).executionState, "ready");
		assert.equal((await runtime.call("snapshot", scope)).running, false);
		assert.equal(
			(await runtime.call("getReceipt", { workspaceId: "work", requestId: "cancel" }))?.execution,
			"unanswered",
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reopened PI live generation stays paused even when another conversation submits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-paid-pause-"));
	const credentials = {
		async status() {
			return "configured" as const;
		},
		async get() {
			return "fictional";
		},
	};
	let runtime = await openRuntime(directory, { models: deterministicModels(1), credentials, model });
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const first = await runtime.call("createConversation", {
			requestId: "create-5",
			workspaceId: "work",
			title: "Pending",
		});
		const second = await runtime.call("createConversation", {
			requestId: "create-6",
			workspaceId: "work",
			title: "Other",
		});
		const scope = { workspaceId: "work", conversationId: first.conversationId };
		await runtime.call("submit", { ...scope, requestId: "pending", text: "History" });
		await until(async () => (await runtime.call("snapshot", scope)).running);
		await runtime.close();
		runtime = await openRuntime(directory, { models: deterministicModels(200), credentials, model, resume: true });
		assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
		assert.equal((await runtime.call("snapshot", scope)).running, false);
		await assert.rejects(
			runtime.call("submit", {
				workspaceId: "work",
				conversationId: second.conversationId,
				requestId: "other",
				text: "Must not wake history",
			}),
			{ code: "RESUME_REQUIRED" },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.notEqual(
			(await runtime.call("getReceipt", { workspaceId: "work", requestId: "pending" }))?.execution,
			"done",
		);
		await runtime.call("continueWorkspace", { workspaceId: "work" });
		await until(
			async () =>
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "pending" }))?.execution === "done",
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const interruption of ["after_accept", "after_dispatch_mark"] as const) {
	test(`paused cancellation withdraws ${interruption} delivery without resuming other conversations`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-cancel-delivery-"));
		let interrupted = 0;
		const credentials = {
			status: async () => "configured" as const,
			get: async () => {
				throw new Error("No secret read");
			},
		};
		let runtime = await openRuntime(directory, {
			models: deterministicModels(2000),
			model,
			credentials,
			failpoint: async (point) => {
				if (point === interruption) {
					interrupted++;
					throw new Error("Interrupted delivery");
				}
			},
		});
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
			const first = await runtime.call("createConversation", {
				requestId: "create-7",
				workspaceId: "work",
				title: "Cancel",
			});
			const second = await runtime.call("createConversation", {
				requestId: "create-8",
				workspaceId: "work",
				title: "Keep",
			});
			const scope = { workspaceId: "work", conversationId: first.conversationId };
			for (const [conversationId, requestId] of [
				[first.conversationId, "cancel"],
				[second.conversationId, "keep"],
			]) {
				const pending = runtime.call("submit", { workspaceId: "work", conversationId, requestId, text: requestId });
				if (interruption === "after_accept") await assert.rejects(pending, /Interrupted delivery/);
				else await pending;
			}
			await until(async () => interrupted === 2);
			await runtime.close();
			const models = deterministicModels(2000);
			let calls = 0;
			const stream = models.streamSimple.bind(models);
			models.streamSimple = (...args) => {
				calls++;
				return stream(...args);
			};
			runtime = await openRuntime(directory, { models, model, credentials });
			assert.equal((await runtime.call("cancelExecution", scope)).executionState, "paused");
			assert.equal(
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "cancel" }))?.state,
				"cancelled",
			);
			await runtime.call("cancelExecution", scope);
			assert.equal(calls, 0);
			await runtime.close();
			runtime = await openRuntime(directory, { models, model, credentials, resume: true });
			assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
			assert.equal(calls, 0);
			await runtime.call("continueWorkspace", { workspaceId: "work" });
			await until(
				async () =>
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "keep" }))?.execution === "done",
			);
			assert.equal(
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "cancel" }))?.state,
				"cancelled",
			);
			assert.equal((await runtime.call("snapshot", scope)).messages.length, 0);
			assert.equal(calls, 1);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const failAfterIntent of [false, true]) {
	test(`paused PI cancellation survives restart and isolates other conversations (${failAfterIntent ? "interrupted intent" : "normal"})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-cancel-pending-"));
		let credentialState: CredentialState = "configured";
		const credentials = {
			status: async () => credentialState,
			get: async () => {
				throw new Error("No secret read");
			},
		};
		let runtime = await openRuntime(directory, { models: deterministicModels(1), model, credentials });
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
			const first = await runtime.call("createConversation", {
				requestId: "create-9",
				workspaceId: "work",
				title: "Cancel",
			});
			const second = await runtime.call("createConversation", {
				requestId: "create-10",
				workspaceId: "work",
				title: "Keep",
			});
			const scope = { workspaceId: "work", conversationId: first.conversationId };
			await runtime.call("submit", { ...scope, requestId: "cancel", text: "cancel" });
			await runtime.call("submit", { ...scope, requestId: "queued", text: "also cancel queued input" });
			await runtime.call("submit", {
				workspaceId: "work",
				conversationId: second.conversationId,
				requestId: "keep",
				text: "keep",
			});
			await until(
				async () =>
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "queued" }))?.execution ===
						"queued" &&
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "keep" }))?.execution === "placed",
			);
			await runtime.close();
			const models = deterministicModels(2000);
			let calls = 0;
			const stream = models.streamSimple.bind(models);
			models.streamSimple = (...args) => {
				calls++;
				return stream(...args);
			};
			runtime = await openRuntime(directory, {
				models,
				model,
				credentials,
				failpoint: async (point) => {
					if (failAfterIntent && point === "after_cancel_intent")
						throw new Error("Lost cancellation acknowledgement");
				},
			});
			credentialState = "missing";
			if (failAfterIntent)
				await assert.rejects(runtime.call("cancelExecution", scope), /Lost cancellation acknowledgement/);
			else assert.equal((await runtime.call("cancelExecution", scope)).executionState, "cancellation_pending");
			assert.equal(calls, 0);
			await runtime.close();
			runtime = await openRuntime(directory, { models, model, credentials, resume: true });
			assert.equal((await runtime.call("getConversationModel", scope)).executionState, "cancellation_pending");
			assert.equal(
				(await runtime.call("getConversationModel", { workspaceId: "work", conversationId: second.conversationId }))
					.executionState,
				"paused",
			);
			assert.equal(
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "queued" }))?.execution,
				"unanswered",
			);
			assert.equal(
				(await runtime.call("getReceipt", { workspaceId: "work", requestId: "cancel" }))?.execution,
				"placed",
				"Cancellation request must not claim PI already settled",
			);
			assert.equal((await runtime.call("snapshot", scope)).running, false);
			await runtime.call("cancelExecution", scope);
			await assert.rejects(runtime.call("submit", { ...scope, requestId: "blocked", text: "No implicit resume" }), {
				code: "RESUME_REQUIRED",
			});
			assert.equal(calls, 0);
			await assert.rejects(runtime.call("continueWorkspace", { workspaceId: "work" }), {
				code: "CREDENTIAL_REQUIRED",
			});
			assert.equal((await runtime.call("getConversationModel", scope)).executionState, "cancellation_pending");
			credentialState = "configured";
			await runtime.call("continueWorkspace", { workspaceId: "work" });
			await until(
				async () =>
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "keep" }))?.execution === "done" &&
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "cancel" }))?.execution ===
						"unanswered",
			);
			assert.equal(calls, 1, "Only the explicitly continued other conversation may invoke the model");
			assert.equal((await runtime.call("getConversationModel", scope)).executionState, "ready");
			await runtime.call("submit", { ...scope, requestId: "new", text: "New authorized input" });
			await until(
				async () =>
					(await runtime.call("getReceipt", { workspaceId: "work", requestId: "new" }))?.execution === "done",
			);
			assert.equal(calls, 2);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
