import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWorkspaceModels, type ModelDispatchAuthorization } from "../src/agent-tools/model-gate.ts";
import {
	type CustomProviderConfiguration,
	type CustomProviderProtocol,
	type ModelFailureCategory,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
} from "../src/contracts.ts";
import { backupStore } from "../src/maintenance/backup.ts";
import { restoreStore } from "../src/maintenance/restore.ts";
import { inspectCatalog } from "../src/maintenance/sqlite.ts";
import { verifyBackup } from "../src/maintenance/verify.ts";
import { type CredentialPort, configureCustomProviders, createProductionModels } from "../src/model-provider.ts";
import { openRuntime } from "../src/node.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";

function settings(protocol: CustomProviderProtocol = "openai-completions", baseUrl = "https://example.invalid/v1") {
	return {
		vendorId: "custom",
		name: "My service",
		protocol,
		baseUrl,
		models: [{ id: "test/model", name: "Trial model" }],
	};
}
const input = { messages: [{ role: "user" as const, content: "Synthetic test input", timestamp: 1 }] };
function reply(res: ServerResponse, protocol: CustomProviderProtocol) {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const event = (value: unknown) => {
		if (protocol === "anthropic-messages" && value && typeof value === "object" && "type" in value)
			res.write(`event: ${value.type}\n`);
		res.write(`data: ${JSON.stringify(value)}\n\n`);
	};
	if (protocol === "openai-completions") {
		event({
			id: "fake",
			object: "chat.completion.chunk",
			created: 1,
			model: "test/model",
			choices: [{ index: 0, delta: { role: "assistant", content: "Local fixture answer" }, finish_reason: null }],
		});
		event({
			id: "fake",
			object: "chat.completion.chunk",
			created: 1,
			model: "test/model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
		});
		res.end("data: [DONE]\n\n");
	} else {
		event({
			type: "message_start",
			message: {
				id: "fake",
				type: "message",
				role: "assistant",
				model: "test/model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		});
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local fixture answer" } });
		event({ type: "content_block_stop", index: 0 });
		event({
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 4 },
		});
		event({ type: "message_stop" });
		res.end();
	}
}
async function fixtureServer(protocol: CustomProviderProtocol) {
	const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
	let failure: number | undefined;
	const server = createServer(async (request, response) => {
		const bytes: Buffer[] = [];
		for await (const chunk of request) bytes.push(Buffer.from(chunk));
		requests.push({
			url: request.url ?? "",
			headers: request.headers,
			body: JSON.parse(Buffer.concat(bytes).toString()),
		});
		if (failure === 0) {
			response.destroy();
		} else if (failure !== undefined) {
			response.writeHead(failure, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						type: "authentication_error",
						message: `private-diagnostic ${request.headers.authorization ?? request.headers["x-api-key"]}`,
					},
				}),
			);
		} else reply(response, protocol);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		url: `http://127.0.0.1:${address.port}/gateway${protocol === "openai-completions" ? "/v1" : ""}`,
		requests,
		fail: (status = 401) => {
			failure = status;
		},
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
function credentialFixture() {
	const keys = new Map<string, string>();
	const reads: string[] = [];
	const credentials: CredentialPort = {
		status: async (id) => (keys.has(id) ? "configured" : "missing"),
		get: async (id) => {
			reads.push(id);
			return keys.get(id);
		},
	};
	return { keys, reads, credentials };
}
async function terminal(runtime: Awaited<ReturnType<typeof openRuntime>>, requestId: string) {
	const end = Date.now() + 10000;
	while (Date.now() < end) {
		const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId });
		if (receipt?.execution === "done" || receipt?.execution === "unanswered") return receipt;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Fixture did not finish: ${requestId}`);
}

test("configuration contracts reject secret fields, ambiguous endpoints, duplicates and unbounded models", () => {
	const valid = {
		version: PROTOCOL_VERSION,
		method: "saveCustomProvider",
		params: { requestId: "save", ...settings() },
	};
	assert.equal(parseRequest(valid).method, "saveCustomProvider");
	for (const baseUrl of [
		"file:///tmp/test",
		"https://user:pass@example.com",
		"https://example.com?secret=x",
		"https://example.com?",
		"https://example.com/#secret",
		"https://example.com/#",
		"https://example.com/\npath",
		"https://example.com/%0asecret",
		"https://example.com\\path",
		"http://remote.example/v1",
		"https://example.com/chat/completions",
	])
		assert.throws(() => parseRequest({ ...valid, params: { ...valid.params, baseUrl } }), {
			code: "INVALID_REQUEST",
		});
	for (const baseUrl of ["https://example.com/v1", "https://example.com/v1/messages"]) {
		assert.throws(
			() => parseRequest({ ...valid, params: { ...valid.params, protocol: "anthropic-messages", baseUrl } }),
			{ code: "INVALID_REQUEST" },
		);
	}
	for (const extra of [
		{ apiKey: "secret" },
		{ headers: { Authorization: "secret" } },
		{ protocol: "other" },
		{ models: [] },
		{ models: [...valid.params.models, ...valid.params.models] },
		{ models: Array.from({ length: 17 }, (_, i) => ({ id: `${i}`, name: "Model" })) },
		{ provider: "openai" },
	])
		assert.throws(() => parseRequest({ ...valid, params: { ...valid.params, ...extra } }), {
			code: "INVALID_REQUEST",
		});
	const normalized = parseResult("saveCustomProvider", {
		provider: "custom_fixture",
		...settings("anthropic-messages", "https://example.com/proxy/"),
	});
	assert.equal(normalized.baseUrl, "https://example.com/proxy");
	assert.throws(() => parseResult("saveCustomProvider", { ...normalized, apiKey: "secret" }), {
		code: "INVALID_REQUEST",
	});
});

test("provider configuration uses the same validated application contract over HTTP and child IPC", async () => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-provider-transports-"));
	const credentials = credentialFixture();
	const runtime = await openRuntime(join(parent, "http"), {
		models: createProductionModels(credentials.credentials),
		credentials: credentials.credentials,
	});
	const origin = "http://127.0.0.1:5173";
	const server = await serveLoopback(runtime, { origin });
	const child = fork(new URL("./helpers/custom-provider-runtime.ts", import.meta.url), [join(parent, "ipc")], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const ipc = createNodeIpcClient(child);
	try {
		for (const client of [createHttpClient({ ...server, origin }), ipc]) {
			const profile = await client.call("saveCustomProvider", { ...settings(), requestId: "save" });
			assert.deepEqual(await client.call("listCustomProviders", {}), { providers: [profile] });
			assert.equal(
				(await client.call("listModels", {})).models.find((model) => model.provider === profile.provider)?.modelId,
				"test/model",
			);
			assert.equal((await client.call("getBuiltInProviderModels", { vendorId: "anthropic" })).vendorId, "anthropic");
			await assert.rejects(
				client.call("saveCustomProvider", { ...settings(), requestId: "save", name: "Different payload" }),
				{ code: "IDEMPOTENCY_CONFLICT" },
			);
			await assert.rejects(client.call("getBuiltInProviderModels", { vendorId: "not-a-bundled-vendor" }), {
				code: "NOT_FOUND",
			});
			await client.call("removeCustomProvider", { requestId: "remove", provider: profile.provider });
			assert.deepEqual(await client.call("listCustomProviders", {}), { providers: [] });
		}
	} finally {
		ipc.close();
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.disconnect();
			await exited;
		}
		await server.close();
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});

for (const protocol of ["openai-completions", "anthropic-messages"] as const) {
	test(`${protocol}: safe failure evidence survives HTTP, persistence and child IPC without retries`, async () => {
		const server = await fixtureServer(protocol);
		const directory = await mkdtemp(join(tmpdir(), "hipi-provider-failure-evidence-"));
		const secret = "synthetic-failure-evidence-key";
		let missingSecret = false;
		const credentials: CredentialPort = {
			status: async () => "configured",
			get: async () => (missingSecret ? undefined : secret),
		};
		const runtime = await openRuntime(directory, { models: createProductionModels(credentials), credentials });
		const origin = "http://127.0.0.1:5173";
		const http = await serveLoopback(runtime, { origin });
		let httpClosed = false;
		const client = createHttpClient({ ...http, origin });
		const receipts = [];
		try {
			await client.call("createWorkspace", { workspaceId: "work", name: "Failures" });
			const profile = await client.call("saveCustomProvider", {
				requestId: "save",
				...settings(protocol, server.url),
			});
			const matrix: [number, ModelFailureCategory][] = [
				[401, "model_auth_failed"],
				[403, "model_auth_failed"],
				[429, "model_rate_limited"],
				[400, "model_request_rejected"],
				[404, "model_unavailable"],
				[503, "model_service_unavailable"],
				[0, "model_network_failed"],
				[200, "model_request_failed"],
			];
			for (const [index, [status, category]] of matrix.entries()) {
				server.fail(status);
				const conversation = await client.call("createConversation", {
					workspaceId: "work",
					requestId: `conversation-${index}`,
					title: "Synthetic failure",
					model: { provider: profile.provider, modelId: "test/model" },
				});
				const requestId = `failure-${index}`;
				await client.call("submit", {
					workspaceId: "work",
					conversationId: conversation.conversationId,
					requestId,
					text: "Synthetic input",
				});
				await terminal(runtime, requestId);
				const receipt = await client.call("getReceipt", { workspaceId: "work", requestId });
				assert.equal(receipt?.execution, "unanswered");
				assert.equal(receipt.reason, "model_error");
				assert.deepEqual(receipt.modelFailure, { category, dispatch: "attempted" });
				assert.equal(server.requests.length, index + 1, "failure does not retry or replay");
				assert.equal(JSON.stringify(receipt).includes(secret), false);
				assert.equal(JSON.stringify(receipt).includes("private-diagnostic"), false);
				receipts.push(receipt);
			}
			missingSecret = true;
			const local = await client.call("createConversation", {
				workspaceId: "work",
				requestId: "local-conversation",
				title: "Local credential failure",
				model: { provider: profile.provider, modelId: "test/model" },
			});
			await client.call("submit", {
				workspaceId: "work",
				conversationId: local.conversationId,
				requestId: "local-failure",
				text: "Not sent",
			});
			const localReceipt = await terminal(runtime, "local-failure");
			assert.deepEqual(localReceipt.modelFailure, { category: "credential_required", dispatch: "not_sent" });
			assert.equal(server.requests.length, matrix.length);
			receipts.push(localReceipt);
			await http.close();
			httpClosed = true;
			await runtime.close();
			const child = fork(new URL("./helpers/custom-provider-runtime.ts", import.meta.url), [directory], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			const ipc = createNodeIpcClient(child);
			try {
				for (const receipt of receipts)
					assert.deepEqual(
						await ipc.call("getReceipt", { workspaceId: "work", requestId: receipt.requestId }),
						receipt,
					);
				assert.equal(server.requests.length, matrix.length, "restart and receipt reads cannot resend");
			} finally {
				ipc.close();
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.disconnect();
					await exited;
				}
			}
			for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const contents = await readFile(join(entry.parentPath, entry.name));
				assert.equal(contents.includes(Buffer.from(secret)), false);
				assert.equal(contents.includes(Buffer.from("private-diagnostic")), false);
			}
		} finally {
			if (!httpClosed) await http.close();
			await runtime.close();
			await server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test(
		`${protocol}: local SDK request, scoped key, runtime conversation and restart use only saved configuration`,
		{ timeout: 20000 },
		async () => {
			const server = await fixtureServer(protocol);
			const directory = await mkdtemp(join(tmpdir(), "hipi-custom-provider-"));
			const credentials = credentialFixture();
			const previousOpenAI = process.env.OPENAI_API_KEY;
			const previousAnthropic = process.env.ANTHROPIC_API_KEY;
			process.env.OPENAI_API_KEY = "ambient-openai-do-not-send";
			process.env.ANTHROPIC_API_KEY = "ambient-anthropic-do-not-send";
			let models = createProductionModels(credentials.credentials);
			let runtime = await openRuntime(directory, { models, credentials: credentials.credentials });
			try {
				// Workspace exists before settings: publishing a profile must not require restarting it.
				await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
				const save = { requestId: "save", ...settings(protocol, server.url) };
				const profile = await runtime.call("saveCustomProvider", save);
				assert.match(profile.provider, /^custom_[a-f0-9-]+$/);
				assert.deepEqual(await runtime.call("saveCustomProvider", save), profile);
				assert.deepEqual((await runtime.call("listCustomProviders", {})).providers, [profile]);
				const vendors = await runtime.call("listBuiltInProviders", {});
				assert.ok(vendors.providers.some((vendor) => vendor.vendorId === "anthropic"));
				assert.ok((await runtime.call("getBuiltInProviderModels", { vendorId: "openai" })).models.length);
				assert.equal(server.requests.length, 0);
				assert.deepEqual(credentials.reads, []);
				const model = models.getModel(profile.provider, "test/model");
				assert.ok(model);
				const missing = await models.completeSimple(model, input, { apiKey: "caller-must-not-override" });
				assert.equal(missing.errorMessage, "hipi_model_failure:credential_required:not_sent");
				assert.equal(server.requests.length, 0);
				credentials.keys.set(profile.provider, `synthetic-${protocol}-key`);
				const other = await runtime.call("saveCustomProvider", { ...save, requestId: "other", name: "Other" });
				credentials.keys.set(other.provider, "synthetic-other-profile-key");
				await assert.rejects(
					runtime.call("createConversation", {
						workspaceId: "work",
						requestId: "unknown",
						title: "Unknown",
						model: { provider: profile.provider, modelId: "not-configured" },
					}),
					{ code: "MODEL_UNAVAILABLE" },
				);
				const conversation = await runtime.call("createConversation", {
					workspaceId: "work",
					requestId: "chat",
					title: "Trial",
					model: { provider: profile.provider, modelId: model.id },
				});
				await runtime.call("submit", {
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
					requestId: "turn",
					text: "Synthetic input",
				});
				const receipt = await terminal(runtime, "turn");
				assert.equal(receipt.execution, "done", receipt.reason);
				assert.match(receipt.answer ?? "", /Local fixture answer/);
				assert.equal(server.requests.length, 1);
				assert.equal(
					server.requests[0].url,
					protocol === "openai-completions" ? "/gateway/v1/chat/completions" : "/gateway/v1/messages?beta=true",
				);
				assert.equal(server.requests[0].body.model, "test/model");
				assert.equal(
					server.requests[0].headers[protocol === "openai-completions" ? "authorization" : "x-api-key"],
					`${protocol === "openai-completions" ? "Bearer " : ""}synthetic-${protocol}-key`,
				);
				assert.equal(JSON.stringify(server.requests).includes("ambient-"), false);
				assert.equal(JSON.stringify(server.requests).includes("synthetic-other-profile-key"), false);
				await runtime.close();
				models = createProductionModels(credentials.credentials);
				runtime = await openRuntime(directory, { models, credentials: credentials.credentials, resume: true });
				assert.deepEqual(
					(await runtime.call("listCustomProviders", {})).providers.find(
						(entry) => entry.provider === profile.provider,
					),
					profile,
				);
				assert.equal(server.requests.length, 1, "restart/list must not dispatch");
				const scope = { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId };
				const changed = await runtime.call("saveCustomProvider", {
					...save,
					provider: profile.provider,
					requestId: "endpoint-change",
					baseUrl: `${server.url}/new-prefix`,
				});
				assert.notEqual(changed.provider, profile.provider);
				assert.equal(models.getModel(profile.provider, model.id), undefined);
				assert.equal((await runtime.call("getConversationModel", scope)).credentialState, "unavailable");
				await assert.rejects(
					runtime.call("submit", { ...scope, requestId: "old-recipient", text: "Must not send history" }),
					{ code: "MODEL_UNAVAILABLE" },
				);
				assert.equal(
					(await models.completeSimple(model, input)).errorMessage,
					"hipi_model_failure:model_unavailable:not_sent",
				);
				assert.equal(server.requests.length, 1);
				await runtime.call("removeCustomProvider", { provider: changed.provider, requestId: "remove" });
				await runtime.call("saveCustomProvider", save);
				assert.equal(
					models.getModel(profile.provider, model.id),
					undefined,
					"old command replay must not reinstall a removed profile",
				);
				await runtime.close();
				for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
					if (entry.isFile())
						assert.equal(
							(await readFile(join(entry.parentPath, entry.name))).includes(
								Buffer.from(`synthetic-${protocol}-key`),
							),
							false,
						);
				}
			} finally {
				await runtime.close();
				await server.close();
				await rm(directory, { recursive: true, force: true });
				if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
				else process.env.OPENAI_API_KEY = previousOpenAI;
				if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
				else process.env.ANTHROPIC_API_KEY = previousAnthropic;
			}
		},
	);
}

test("configured provider removal during credential resolution blocks final dispatch and sanitized errors stay private", async () => {
	const server = await fixtureServer("openai-completions");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const credentials: CredentialPort = {
		status: async () => {
			entered.resolve();
			await release.promise;
			return "configured";
		},
		get: async () => "synthetic-private-key",
	};
	const models = createProductionModels(credentials);
	const value: CustomProviderConfiguration = {
		provider: "custom_fixture",
		...settings("openai-completions", server.url),
	};
	configureCustomProviders(models, [value]);
	const model = models.getModel(value.provider, "test/model");
	assert.ok(model);
	try {
		const pending = models.completeSimple(model, input);
		await entered.promise;
		configureCustomProviders(models, []);
		release.resolve();
		assert.equal((await pending).errorMessage, "hipi_model_failure:model_unavailable:not_sent");
		assert.equal(server.requests.length, 0);
		configureCustomProviders(models, [value]);
		server.fail();
		const failed = await models.completeSimple(model, input);
		assert.equal(failed.stopReason, "error");
		assert.equal(JSON.stringify(failed).includes("synthetic-private-key"), false);
		assert.equal(JSON.stringify(failed).includes("private-diagnostic"), false);
	} finally {
		release.resolve();
		await server.close();
	}
});

test("metadata edits keep active models alive; custom deferred requests fail before credentials or dispatch", async () => {
	const server = await fixtureServer("openai-completions");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let reads = 0;
	const models = createProductionModels({
		status: async () => {
			reads++;
			entered.resolve();
			await release.promise;
			return "configured";
		},
		get: async () => "synthetic-test-key",
	});
	const profile: CustomProviderConfiguration = {
		provider: "custom_edit",
		...settings("openai-completions", server.url),
	};
	configureCustomProviders(models, [profile]);
	const model = models.getModel(profile.provider, "test/model");
	assert.ok(model);
	try {
		const handle = { provider: profile.provider, api: model.api, modelId: model.id, id: "unsupported" };
		assert.equal(
			(await models.streamDeferred(model, handle).result()).errorMessage,
			"hipi_model_failure:model_unavailable:not_sent",
		);
		await assert.rejects(models.cancelDeferred(model, handle), /model_cancel_failed/);
		assert.equal(
			(await models.completeSimple(model, input, { deferred: true })).errorMessage,
			"hipi_model_failure:model_unavailable:not_sent",
		);
		assert.equal(reads, 0);
		const provider = models.getProvider(profile.provider);
		const pending = models.completeSimple(model, input);
		await entered.promise;
		configureCustomProviders(models, [
			{ ...profile, name: "Renamed", models: [...profile.models, { id: "added", name: "Added" }] },
		]);
		assert.equal(models.getProvider(profile.provider), provider);
		assert.equal(models.getProvider(profile.provider)?.name, "Renamed");
		release.resolve();
		assert.equal((await pending).stopReason, "stop");
		assert.equal(server.requests.length, 1);
		assert.throws(() => configureCustomProviders(models, [{ ...profile, baseUrl: `${server.url}/changed` }]), {
			code: "INVALID_REQUEST",
		});
		configureCustomProviders(models, [{ ...profile, models: [{ id: "added", name: "Added" }] }]);
		assert.equal(
			(await models.completeSimple(model, input)).errorMessage,
			"hipi_model_failure:model_unavailable:not_sent",
		);
		assert.equal(server.requests.length, 1);
	} finally {
		release.resolve();
		await server.close();
	}
});

test("protocol rotation and removal keep interrupted history paused after restart", async () => {
	const server = await fixtureServer("openai-completions");
	const directory = await mkdtemp(join(tmpdir(), "hipi-provider-pending-"));
	const credentials = credentialFixture();
	let runtime = await openRuntime(directory, {
		models: createProductionModels(credentials.credentials),
		credentials: credentials.credentials,
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("Synthetic interruption");
		},
	});
	try {
		const profile = await runtime.call("saveCustomProvider", {
			...settings("openai-completions", server.url),
			requestId: "profile",
		});
		credentials.keys.set(profile.provider, "synthetic-key");
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "conversation",
			title: "Pending",
			model: { provider: profile.provider, modelId: profile.models[0].id },
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		await assert.rejects(
			runtime.call("submit", { ...scope, requestId: "pending", text: "Synthetic interrupted input" }),
			/Synthetic interruption/,
		);
		const changed = await runtime.call("saveCustomProvider", {
			...settings("anthropic-messages", server.url.replace(/\/v1$/, "")),
			provider: profile.provider,
			requestId: "protocol",
		});
		assert.notEqual(changed.provider, profile.provider);
		assert.equal(
			(await runtime.call("listModels", {})).providers.find((entry) => entry.provider === changed.provider)
				?.credentialState,
			"missing",
		);
		await runtime.close();
		runtime = await openRuntime(directory, {
			models: createProductionModels(credentials.credentials),
			credentials: credentials.credentials,
			resume: true,
		});
		assert.equal((await runtime.call("getConversationModel", scope)).executionState, "paused");
		await assert.rejects(runtime.call("continueWorkspace", { workspaceId: "work" }), { code: "MODEL_UNAVAILABLE" });
		assert.equal(
			(await runtime.call("getReceipt", { workspaceId: "work", requestId: "pending" }))?.state,
			"accepted",
		);
		assert.deepEqual(credentials.reads, [], "unavailable history must not resolve any key");
		assert.equal(server.requests.length, 0);
	} finally {
		await runtime.close();
		await server.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("recipient identity and exact URL are rechecked after the context authorization wait", async () => {
	const server = await fixtureServer("anthropic-messages");
	const credentials = credentialFixture();
	const source = createProductionModels(credentials.credentials);
	const value: CustomProviderConfiguration = {
		provider: "custom_original",
		...settings("anthropic-messages", server.url),
	};
	configureCustomProviders(source, [value]);
	credentials.keys.set(value.provider, "synthetic-key");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const authorization: ModelDispatchAuthorization = {
		check: async (_session, model) => {
			assert.equal(model.provider, value.provider);
			entered.resolve();
			await release.promise;
		},
		start: async (_session, model, _controller, dispatch) => {
			assert.equal(model.provider, value.provider);
			return { response: dispatch(), release: () => {} };
		},
	};
	const models = createWorkspaceModels(source, authorization);
	const model = models.getModel(value.provider, "test/model");
	assert.ok(model);
	try {
		const pending = models.completeSimple(model, input, { sessionId: "authorized-conversation" });
		await entered.promise;
		configureCustomProviders(source, [{ ...value, provider: "custom_replacement", baseUrl: `${server.url}/other` }]);
		release.resolve();
		assert.equal((await pending).errorMessage, "hipi_model_failure:model_context_blocked:not_sent");
		assert.equal(server.requests.length, 0);
		configureCustomProviders(source, [value]);
		assert.equal(
			(
				await models.completeSimple({ ...model, baseUrl: `${server.url}/forged` }, input, {
					sessionId: "authorized-conversation",
				})
			).errorMessage,
			"hipi_model_failure:model_context_blocked:not_sent",
		);
		assert.equal(server.requests.length, 0);
	} finally {
		release.resolve();
		await server.close();
	}
});

test("catalog schema 3 migration, schema 6 backup and non-executing restore preserve profile snapshots without credentials", async () => {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "hipi-provider-backup-")));
	const source = join(parent, "source");
	const credentials = credentialFixture();
	let runtime = await openRuntime(source, {
		models: createProductionModels(credentials.credentials),
		credentials: credentials.credentials,
	});
	try {
		await runtime.close();
		const legacy = new DatabaseSync(join(source, "catalog.sqlite"));
		legacy.exec(
			"DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state; DROP TABLE conversation_presentations; DROP TABLE presentation_state; DROP TABLE presentation_commands; DROP TABLE project_folders; DROP TABLE custom_providers; DROP TABLE provider_commands; UPDATE identity SET version=3",
		);
		legacy.close();
		assert.equal(inspectCatalog(join(source, "catalog.sqlite")).catalogSchema, 3);
		const oldBackup = await backupStore({ source, destination: join(parent, "old-backup") });
		assert.equal(oldBackup.manifest.catalogSchema, 3);
		runtime = await openRuntime(source, {
			models: createProductionModels(credentials.credentials),
			credentials: credentials.credentials,
		});
		const profile = await runtime.call("saveCustomProvider", { ...settings(), requestId: "save" });
		credentials.keys.set(profile.provider, "synthetic-key-not-for-backup");
		await runtime.close();
		assert.equal(inspectCatalog(join(source, "catalog.sqlite")).catalogSchema, 8);
		// Retain an actual schema6 backup fixture, not a version label over schema7 tables.
		const configured = new DatabaseSync(join(source, "catalog.sqlite"));
		try {
			configured.exec(
				"DROP TABLE search_chunks; DROP TABLE search_sources; DROP TABLE search_state; DROP TABLE conversation_presentations; DROP TABLE presentation_state; DROP TABLE presentation_commands; UPDATE identity SET version=6",
			);
		} finally {
			configured.close();
		}
		assert.equal(inspectCatalog(join(source, "catalog.sqlite")).catalogSchema, 6);
		const backup = await backupStore({ source, destination: join(parent, "backup") });
		assert.equal(backup.manifest.catalogSchema, 6);
		await verifyBackup({ directory: backup.directory });
		const db = new DatabaseSync(join(backup.directory, "catalog.sqlite"), { readOnly: true });
		assert.deepEqual(
			JSON.parse(
				String(db.prepare("SELECT value FROM custom_providers WHERE provider=?").get(profile.provider)?.value),
			),
			profile,
		);
		db.close();
		assert.equal(
			(await readFile(join(backup.directory, "catalog.sqlite"))).includes(
				Buffer.from("synthetic-key-not-for-backup"),
			),
			false,
		);
		const restored = await restoreStore({ source: backup.directory, destination: join(parent, "recovery") });
		assert.equal(restored.mode, "recovery_archive");
		await assert.rejects(
			openRuntime(restored.directory, {
				models: createProductionModels(credentials.credentials),
				credentials: credentials.credentials,
			}),
			{ code: "STORE_MISMATCH" },
		);
		const future = new DatabaseSync(join(source, "catalog.sqlite"));
		future.exec("UPDATE identity SET version=9");
		future.close();
		assert.throws(() => inspectCatalog(join(source, "catalog.sqlite")), { code: "UNSUPPORTED_SCHEMA" });
		await assert.rejects(
			openRuntime(source, {
				models: createProductionModels(credentials.credentials),
				credentials: credentials.credentials,
			}),
			{ code: "STORE_MISMATCH" },
		);
	} finally {
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});
