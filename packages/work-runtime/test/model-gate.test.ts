import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import {
	createModels,
	type FetchFunction,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type ConversationId, Harness, MemoryStorage, ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createWorkspaceModels, type ModelDispatchAuthorization } from "../src/agent-tools/model-gate.ts";
import { AgentToolBroker, agentRegistry } from "../src/agent-tools.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { type CredentialPort, createProductionModels } from "../src/model-provider.ts";

const credentials: CredentialPort = { status: async () => "configured", get: async () => "sk-fake-never-a-real-key" };
const context = { messages: [] };
function response() {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			sequence_number: 0,
			response: {
				id: "fake",
				status: "completed",
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			},
		})}\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
function authority() {
	const allowed = new Set(["a", "b"]);
	const active = new Map<string, Set<AbortController>>();
	let checks = 0;
	const port: ModelDispatchAuthorization = {
		async check(session, model) {
			checks++;
			assert.equal(model.provider, "openai");
			if (!allowed.has(session)) throw new Error("private-denial");
		},
		async start(session, model, controller, dispatch) {
			await port.check(session, model);
			const controllers = active.get(session) ?? new Set<AbortController>();
			active.set(session, controllers);
			controllers.add(controller);
			try {
				return {
					response: dispatch(),
					release: () => {
						controllers.delete(controller);
					},
				};
			} catch (error) {
				controllers.delete(controller);
				throw error;
			}
		},
	};
	return {
		port,
		allowed,
		active,
		checks: () => checks,
		revoke(session: string) {
			allowed.delete(session);
			for (const controller of active.get(session) ?? []) controller.abort();
		},
	};
}

test("actual OpenAI SDK uses final fetch for stream and both completion routes, overriding caller transport", async () => {
	const auth = authority();
	let requests = 0;
	const fetch: FetchFunction = async (input, init) => {
		requests++;
		assert.equal(String(input), "https://api.openai.com/v1/responses");
		assert.equal(init?.redirect, "error");
		assert.equal(init?.method, "POST");
		assert.ok(init?.signal);
		return response();
	};
	const source = createProductionModels(credentials);
	const original = source.stream;
	const models = createWorkspaceModels(source, auth.port, fetch);
	const model = models.getModels()[0];
	assert.ok(model);
	const options = {
		sessionId: "a",
		transport: "websocket" as const,
		fetch: async () => {
			throw new Error("caller fetch bypass");
		},
	};
	assert.equal((await models.complete(model, context, options)).stopReason, "stop");
	assert.equal((await models.completeSimple(model, context, options)).stopReason, "stop");
	assert.equal((await models.streamSimple(model, context, options).result()).stopReason, "stop");
	assert.equal(source.stream, original);
	assert.equal(requests, 3);
	assert.equal(auth.checks(), 6);
});

test("missing/unknown session and deferred mode fail closed without network; catalog remains available", async () => {
	const auth = authority();
	let requests = 0;
	const models = createWorkspaceModels(createProductionModels(credentials), auth.port, async () => {
		requests++;
		return response();
	});
	const model = models.getModels()[0];
	assert.ok(model);
	for (const options of [undefined, { sessionId: "unknown" }, { sessionId: "a", deferred: true }]) {
		assert.equal(
			(await models.completeSimple(model, context, options)).errorMessage,
			"hipi_model_failure:model_context_blocked:not_sent",
		);
	}
	await assert.rejects(
		models.fetchDeferred(model, { provider: "openai", api: model.api, modelId: model.id, id: "not-a-session" }),
		/model_operation_not_supported/,
	);
	assert.equal(requests, 0);
});

test("revocation during credentials wait blocks A at final dispatch while workspace B remains usable", async () => {
	const auth = authority();
	const entered = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<void>();
	let requests = 0;
	const source = createProductionModels({
		status: async () => {
			entered.resolve();
			await ready.promise;
			return "configured";
		},
		get: credentials.get,
	});
	const a = createWorkspaceModels(source, auth.port, async () => {
		requests++;
		return response();
	});
	const b = createWorkspaceModels(source, auth.port, async () => {
		requests++;
		return response();
	});
	const model = a.getModels()[0];
	assert.ok(model);
	const pending = a.completeSimple(model, context, { sessionId: "a" });
	await entered.promise;
	auth.revoke("a");
	ready.resolve();
	assert.equal((await pending).errorMessage, "hipi_model_failure:model_context_blocked:not_sent");
	assert.equal(requests, 0);
	assert.equal((await b.completeSimple(model, context, { sessionId: "b" })).stopReason, "stop");
	assert.equal(requests, 1);
});

test("replacing the underlying provider after facade construction is rejected", async () => {
	const source = createModels();
	source.setProvider(openaiProvider());
	const models = createWorkspaceModels(source, authority().port, async () => {
		throw new Error("Must not fetch");
	});
	const model = models.getModels()[0];
	assert.ok(model);
	source.setProvider(openaiProvider());
	assert.equal(
		(await models.completeSimple(model, context, { sessionId: "a" })).errorMessage,
		"hipi_model_failure:model_context_blocked:not_sent",
	);
});

test("revoke after response headers aborts the ongoing SSE stream and releases registrations", async () => {
	const auth = authority();
	const entered = Promise.withResolvers<void>();
	let signal: AbortSignal | null | undefined;
	const models = createWorkspaceModels(createProductionModels(credentials), auth.port, async (_input, init) => {
		signal = init?.signal;
		entered.resolve();
		return new Response(
			new ReadableStream({
				start(controller) {
					init?.signal?.addEventListener("abort", () => controller.error(new Error("fake-abort")), { once: true });
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	const model = models.getModels()[0];
	assert.ok(model);
	const pending = models.completeSimple(model, context, { sessionId: "a" });
	await entered.promise;
	auth.revoke("a");
	assert.equal((await pending).stopReason, "aborted");
	assert.equal(signal?.aborted, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(auth.active.get("a")?.size, 0);
});

test("non-official URL is rejected before fake fetch", async () => {
	const models = createWorkspaceModels(createProductionModels(credentials), authority().port, async () => {
		throw new Error("Must not fetch");
	});
	const model = models.getModels()[0];
	assert.ok(model);
	assert.equal(
		(await models.completeSimple({ ...model, baseUrl: "https://untrusted.invalid/v1" }, context, { sessionId: "a" }))
			.errorMessage,
		"hipi_model_failure:model_context_blocked:not_sent",
	);
});

for (const representation of ["url", "request"] as const) {
	test(`final gate accepts ${representation} inputs and preserves SDK/request abort signals`, async () => {
		const requestController = new AbortController();
		const source = createProductionModels(credentials, () => {
			const provider = openaiProvider();
			const streamSimple = provider.streamSimple;
			provider.streamSimple = (model, transcript, options) =>
				streamSimple(model, transcript, {
					...options,
					fetch: async (input, init) => {
						assert.ok(options?.fetch);
						const url = input instanceof Request ? input.url : input.toString();
						return representation === "url"
							? options.fetch(new URL(url), init)
							: options.fetch(new Request(url, { ...init, signal: requestController.signal }));
					},
				});
			return provider;
		});
		const entered = Promise.withResolvers<void>();
		let effectiveSignal: AbortSignal | null | undefined;
		const models = createWorkspaceModels(source, authority().port, async (_input, init) => {
			effectiveSignal = init?.signal;
			entered.resolve();
			return response();
		});
		const model = models.getModels()[0];
		assert.ok(model);
		const abort = new AbortController();
		const result = models.completeSimple(model, context, { sessionId: "a", signal: abort.signal });
		await entered.promise;
		if (representation === "request") requestController.abort();
		else abort.abort();
		assert.equal(effectiveSignal?.aborted, true);
		await result;
	});
}

test("caller cancellation interrupts a pending credential host without making a request", async () => {
	const entered = Promise.withResolvers<void>();
	const source = createProductionModels({
		status: async () => {
			entered.resolve();
			return new Promise(() => {});
		},
		get: credentials.get,
	});
	const models = createWorkspaceModels(source, authority().port, async () => {
		throw new Error("Must not fetch");
	});
	const model = models.getModels()[0];
	assert.ok(model);
	const controller = new AbortController();
	const pending = models.completeSimple(model, context, { sessionId: "a", signal: controller.signal });
	await entered.promise;
	controller.abort(new Error("private-cancel-reason"));
	const result = await pending;
	assert.equal(result.stopReason, "aborted");
	assert.equal(JSON.stringify(result).includes("private"), false);
});

test("snapshot binds actual request model, not later caller mutations", async () => {
	const entered = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<void>();
	const source = createProductionModels({
		status: async () => {
			entered.resolve();
			await ready.promise;
			return "configured";
		},
		get: credentials.get,
	});
	const auth = authority();
	const expected: string[] = [];
	const port: ModelDispatchAuthorization = {
		...auth.port,
		check: async (session, model) => {
			expected.push(model.id);
			await auth.port.check(session, model);
		},
		start: async (session, model, controller, dispatch) => {
			expected.push(model.id);
			return auth.port.start(session, model, controller, dispatch);
		},
	};
	const models = createWorkspaceModels(source, port, async () => response());
	const found = models.getModels()[0];
	assert.ok(found);
	const model = { ...found };
	const pending = models.completeSimple(model, context, { sessionId: "a" });
	await entered.promise;
	model.id = "mutated-after-start";
	ready.resolve();
	assert.equal((await pending).stopReason, "stop");
	assert.deepEqual(expected, [found.id, found.id]);
});

test("provider replacement during authentication cannot dispatch the previously captured provider", async () => {
	const entered = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<void>();
	const provider = openaiProvider();
	const method = provider.auth.apiKey;
	assert.ok(method);
	const resolve = method.resolve;
	method.resolve = async (...args) => {
		entered.resolve();
		await ready.promise;
		return resolve(...args);
	};
	const source = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	source.setProvider(provider);
	let requests = 0;
	const models = createWorkspaceModels(source, authority().port, async () => {
		requests++;
		return response();
	});
	const model = models.getModels()[0];
	assert.ok(model);
	const pending = models.completeSimple(model, context, { sessionId: "a", apiKey: "sk-fake-never-a-real-key" });
	await entered.promise;
	source.setProvider(openaiProvider());
	ready.resolve();
	assert.equal((await pending).errorMessage, "hipi_model_failure:model_context_blocked:not_sent");
	assert.equal(requests, 0);
});

test(
	"real Durable compaction retains file dependencies across summaries and blocks revoked scopes and retries",
	{ timeout: 15000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-compaction-gate-"));
		await writeFile(join(directory, "note.txt"), "private file content");
		const files = createFileAuthority({
			securityMode: "cooperative-local-files",
			assertWorkspaceAccess: async () => {},
		});
		const root = await files.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: directory,
			writable: false,
		});
		let broker = new AgentToolBroker(
			"work",
			() => files.forAgent("owner"),
			async (_tx, ids) => ids,
		);
		const faux = fauxProvider({
			provider: "faux",
			api: "hipi-test",
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
			tokensPerSecond: 1000000,
		});
		const source = createModels();
		source.setProvider(faux.provider);
		let summaries = 0;
		let sawRead = false;
		let first = true;
		faux.setResponses(
			Array.from({ length: 50 }, () => (transcript) => {
				const firstMessage = transcript.messages[0];
				if (
					firstMessage?.role === "system" &&
					typeof firstMessage.content === "string" &&
					firstMessage.content.startsWith("You are a context summarization assistant")
				) {
					summaries++;
					return fauxAssistantMessage("Summary derived from private file content.");
				}
				if (first) {
					first = false;
					return fauxAssistantMessage(
						[fauxToolCall("hipi_files_read", { rootId: root.rootId, path: "note.txt" }, { id: "read-file" })],
						{ stopReason: "toolUse" },
					);
				}
				if (
					transcript.messages.some(
						(message) =>
							message.role === "toolResult" && JSON.stringify(message.content).includes("private file content"),
					)
				)
					sawRead = true;
				return fauxAssistantMessage(`Answer ${"a".repeat(400)}`);
			}),
		);
		const open = async () =>
			Harness.open(
				await openNodeSqliteStorage(join(directory, "compaction.sqlite")),
				{
					models: createWorkspaceModels(source, broker),
					registry: agentRegistry(broker),
					conversationCreated: (tx, record) => broker.conversationCreated(tx, record),
					settings: {
						compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 150, backgroundTokens: 0 },
						retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
					},
				},
				background,
			);
		let harness = await open();
		broker.attach(harness);
		try {
			let conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "faux-1" } },
					init: (tx, id) => broker.register(tx, id, "conversation"),
				},
				background,
			);
			const scope = { workspaceId: "work", conversationId: "conversation" };
			const grant = await broker.authorize(conversation.id, {
				...scope,
				requestId: "grant",
				rootId: root.rootId,
				pathPrefixes: [""],
				model: { provider: "faux", modelId: "faux-1" },
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			});
			const assertNoLiveContext = (prompt: string | undefined, rootIds: string[]) => {
				assert.equal(
					prompt,
					"No live file roots are available for this chat and model. File root IDs come only from app context: never invent them or ask the user to type internal rootId values or absolute host paths. Project files require an available connected project folder; additional folders require explicit file-context permission in the app. Do not call file tools until roots are supplied.",
				);
				for (const privateValue of [...rootIds, directory, "note.txt", "private file content", grant.grantId])
					assert.equal(prompt.includes(privateValue), false);
				assert.equal(prompt.includes("Authorized file roots and relative path prefixes:"), false);
			};
			const turn = async () => {
				const submission = await conversation.submit(
					{ type: "input", content: `User ${"u".repeat(400)}` },
					background,
				);
				assert.equal((await submission.wait(background)).status, "done");
			};
			await turn();
			await turn();
			await turn();
			assert.equal(sawRead, true);
			const before = await harness.waitForTask(await conversation.compact(undefined, background), background);
			assert.equal(before.state.outcome.status, "completed");
			assert.equal(summaries, 1);
			await turn();
			await turn();
			const conversationId = conversation.id;
			files.revokeRoot(root.rootId);
			assertNoLiveContext(await broker.promptContext(conversationId), [root.rootId]);
			broker.close();
			await harness.close(background);
			const newRoot = await files.grantRoot({
				principalId: "owner",
				workspaceId: "work",
				absolutePath: directory,
				writable: false,
			});
			assert.notEqual(newRoot.rootId, root.rootId);
			broker = new AgentToolBroker(
				"work",
				() => files.forAgent("owner"),
				async (_tx, ids) => ids,
			);
			harness = await open();
			broker.attach(harness);
			await harness.commit((tx) => broker.register(tx, conversationId, "conversation"), background);
			await broker.recover(conversationId);
			const reopened = await harness.conversation(conversationId, background);
			assert.ok(reopened);
			conversation = reopened;
			const callsBefore = faux.state.callCount;
			const blocked = await harness.waitForTask(await conversation.compact(undefined, background), background);
			assert.equal(blocked.state.outcome.status, "failed");
			assert.equal(faux.state.callCount, callsBefore);
			const retained = await broker.authorizeRetained(conversation.id, {
				...scope,
				requestId: "retained",
				sourceGrantId: grant.grantId,
				model: grant.model,
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			});
			assertNoLiveContext(await broker.promptContext(conversation.id), [root.rootId, newRoot.rootId]);
			const restored = await harness.waitForTask(await conversation.compact(undefined, background), background);
			assert.equal(restored.state.outcome.status, "completed");
			assert.equal(summaries, 2);
			await turn();
			await turn();
			await broker.revoke(conversation.id, {
				...scope,
				requestId: "revoke",
				grantId: retained.grantId,
				expectedRevision: retained.revision,
			});
			for (let attempt = 0; attempt < 2; attempt++) {
				const after = await harness.waitForTask(await conversation.compact(undefined, background), background);
				assert.equal(after.state.outcome.status, "failed");
				assert.equal(summaries, 2, "revoked source and derived summary must not reach the summarization provider");
			}
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
			const shortRetained = await broker.authorizeRetained(conversation.id, {
				...scope,
				requestId: "short-retained",
				sourceGrantId: grant.grantId,
				model: grant.model,
				expiresAt: Date.now() + 150,
				disclosureVersion: 1,
			});
			const provider = await harness.snapshot(ProviderDoc, conversation.id, background);
			assert.ok(provider);
			const model = source.getModel("faux", "faux-1");
			assert.ok(model);
			await assert.rejects(broker.check(provider.sessionId, { ...model, id: "other" }), { code: "UNAUTHORIZED" });
			await assert.rejects(broker.check("forged-session", model), { code: "UNAUTHORIZED" });
			const expiryEntered = Promise.withResolvers<void>();
			const finishExpiry = Promise.withResolvers<void>();
			const activeContexts = broker.activeContexts.bind(broker);
			const expiryCheck = t.mock.method(broker, "activeContexts", async (id: ConversationId) => {
				expiryEntered.resolve();
				await finishExpiry.promise;
				return activeContexts(id);
			});
			const controller = new AbortController();
			const aborted = once(controller.signal, "abort", { signal: t.signal });
			const dispatch = await broker.start(provider.sessionId, model, controller, async () => new Response("fake"));
			try {
				t.mock.timers.tick(150);
				await expiryEntered.promise;
				assert.equal(controller.signal.aborted, false, "expiry is still waiting for its storage check");
				finishExpiry.resolve();
				// Expiry performs asynchronous storage checks; a timer delay is not their completion signal.
				await aborted;
			} finally {
				finishExpiry.resolve();
				expiryCheck.mock.restore();
				dispatch.release();
			}
			assert.equal(controller.signal.aborted, true);
			assert.ok(Date.now() >= shortRetained.expiresAt);
			await assert.rejects(broker.check(provider.sessionId, model), { code: "UNAUTHORIZED" });
			t.mock.timers.reset();
			const expired = await harness.waitForTask(await conversation.compact(undefined, background), background);
			assert.equal(expired.state.outcome.status, "failed");
			assert.equal(summaries, 2);
		} finally {
			broker.close();
			await harness.close(background);
			await files.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("expiry rechecks actual stream dependencies: renewal and unrelated grants do not abort, lost coverage does", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-expiry-renewal-"));
	const files = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await files.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: directory,
		writable: false,
	});
	const broker = new AgentToolBroker(
		"work",
		() => files.forAgent("owner"),
		async (_tx, ids) => ids,
	);
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-test",
		models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
	});
	const source = createModels();
	source.setProvider(faux.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createWorkspaceModels(source, broker),
			registry: agentRegistry(broker),
			conversationCreated: (tx, record) => broker.conversationCreated(tx, record),
		},
		background,
	);
	broker.attach(harness);
	try {
		const modelReference = { provider: "faux", modelId: "faux-1" };
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: modelReference },
				init: (tx, id) => broker.register(tx, id, "conversation"),
			},
			background,
		);
		const base = {
			workspaceId: "work",
			conversationId: "conversation",
			rootId: root.rootId,
			pathPrefixes: [""],
			model: modelReference,
			disclosureVersion: 1 as const,
		};
		let now = Date.now();
		t.mock.method(Date, "now", () => now);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const first = await broker.authorize(conversation.id, {
			...base,
			requestId: "first",
			expiresAt: Date.now() + 300,
		});
		await broker.promptContext(conversation.id);
		const provider = await harness.snapshot(ProviderDoc, conversation.id, background);
		const model = source.getModel("faux", "faux-1");
		assert.ok(provider && model);
		const controller = new AbortController();
		const dispatch = await broker.start(
			provider.sessionId,
			model,
			controller,
			async () => new Response("held stream"),
		);
		const renewed = await broker.authorize(conversation.id, {
			...base,
			requestId: "renewal",
			expiresAt: Date.now() + 900,
		});
		const unrelated = await broker.authorize(conversation.id, {
			...base,
			pathPrefixes: ["unrelated"],
			requestId: "unrelated",
			expiresAt: Date.now() + 150,
		});
		now += 400;
		t.mock.timers.tick(400);
		// Join the expiry callbacks through their conversation lock, including all storage work.
		await broker.locked(conversation.id, async () => {});
		const states = (await broker.contexts(conversation.id)).items;
		assert.equal(states.find((item) => item.grantId === first.grantId)?.status, "expired");
		assert.equal(states.find((item) => item.grantId === unrelated.grantId)?.status, "expired");
		assert.equal(states.find((item) => item.grantId === renewed.grantId)?.status, "active");
		assert.equal(
			controller.signal.aborted,
			false,
			"renewal covers the actual dependency; unrelated expiry is harmless",
		);
		await broker.check(provider.sessionId, model);
		// The timer clock can reach its deadline before the wall clock used by persisted grants.
		now += 499;
		t.mock.timers.tick(500);
		await broker.locked(conversation.id, async () => {});
		assert.equal(controller.signal.aborted, false, "coverage has not reached its wall-clock expiry");
		now += 1;
		t.mock.timers.tick(1);
		await broker.locked(conversation.id, async () => {});
		assert.equal(controller.signal.aborted, true, "the final covering grant expired");
		await assert.rejects(broker.check(provider.sessionId, model), { code: "UNAUTHORIZED" });
		dispatch.release();

		await broker.authorize(conversation.id, {
			...base,
			requestId: "storage-failure",
			expiresAt: now + 300,
		});
		const failureController = new AbortController();
		const failureDispatch = await broker.start(
			provider.sessionId,
			model,
			failureController,
			async () => new Response("held stream during storage failure"),
		);
		const failedCheck = t.mock.method(broker, "activeContexts", async () => {
			throw new Error("simulated expiry storage failure");
		});
		try {
			now += 300;
			t.mock.timers.tick(300);
			await broker.locked(conversation.id, async () => {});
			assert.equal(failureController.signal.aborted, true, "unverifiable expiry must fail closed");
		} finally {
			failedCheck.mock.restore();
			failureDispatch.release();
		}
		await assert.rejects(broker.check(provider.sessionId, model), { code: "UNAUTHORIZED" });
	} finally {
		broker.close();
		await harness.close(background);
		await files.close();
		await rm(directory, { recursive: true, force: true });
	}
});
