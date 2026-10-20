import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { readModelFailureDetail } from "../src/model-failure.ts";
import { type CredentialPort, createProductionModels } from "../src/model-provider.ts";
import { openRuntime } from "../src/node.ts";

const sentinel = "fake-secret-sentinel-not-a-real-key";
const configured: CredentialPort = {
	status: async () => "configured",
	get: async () => sentinel,
};

function message(): AssistantMessage {
	const model = openaiProvider().getModels()[0];
	assert.ok(model);
	return {
		role: "assistant",
		content: [{ type: "text", text: "A deterministic response." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function fixture(run: () => AssistantMessageEventStream) {
	let requests = 0;
	const receivedKeys: (string | undefined)[] = [];
	const provider: Provider = {
		...openaiProvider(),
		stream: (_model, _context, options) => {
			requests++;
			receivedKeys.push(options?.apiKey);
			return run();
		},
		streamSimple: (_model, _context, options) => {
			requests++;
			receivedKeys.push(options?.apiKey);
			return run();
		},
		fetchDeferred: () => run(),
	};
	return { provider, receivedKeys, requests: () => requests };
}

test("production assembly exposes the official OpenAI catalog without fetching or auth", () => {
	const models = createProductionModels({
		status: async () => {
			throw new Error("Must not read credentials for catalog");
		},
		get: async () => {
			throw new Error("Must not read secrets for catalog");
		},
	});
	assert.deepEqual(
		models.getProviders().map((provider) => provider.id),
		["openai"],
	);
	assert.ok(models.getModels("openai").length > 0);
});

test("configured credentials reach the injected transport, and normal output survives", async () => {
	const expected = message();
	const transport = fixture(() => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: expected });
		stream.end();
		return stream;
	});
	const models = createProductionModels(configured, () => transport.provider);
	const model = models.getModels()[0];
	assert.ok(model);
	assert.deepEqual((await models.completeSimple(model, { messages: [] })).content, expected.content);
	assert.deepEqual((await models.complete(model, { messages: [] })).content, expected.content);
	assert.deepEqual(transport.receivedKeys, [sentinel, sentinel]);
});

for (const status of ["missing", "locked", "unavailable"] as const) {
	test(`${status} credentials reject dispatch despite ambient and request overrides`, async () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = sentinel;
		try {
			const transport = fixture(() => {
				throw new Error("Transport must not run");
			});
			const models = createProductionModels(
				{
					status: async () => status,
					get: async () => {
						throw new Error("Secret must not be read");
					},
				},
				() => transport.provider,
			);
			const model = models.getModels()[0];
			assert.ok(model);
			const result = await models.completeSimple(
				model,
				{ messages: [] },
				{
					apiKey: sentinel,
					env: { OPENAI_API_KEY: sentinel },
				},
			);
			assert.equal(
				readModelFailureDetail(result.errorMessage)?.category,
				status === "missing"
					? "credential_required"
					: status === "locked"
						? "credential_locked"
						: "credential_unavailable",
			);
			assert.equal(transport.requests(), 0);
			assert.equal(readModelFailureDetail(result.errorMessage)?.dispatch, "not_sent");
			assert.equal(JSON.stringify(result).includes(sentinel), false);
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
}

for (const failure of ["status", "get", "auth", "throw", "event", "result"] as const) {
	test(`sanitizes ${failure} failures before both events and completion escape`, async () => {
		const transport = fixture(() => {
			if (failure === "throw") throw new Error(sentinel, { cause: { body: sentinel } });
			const stream = createAssistantMessageEventStream();
			const error = message();
			error.stopReason = "error";
			error.errorMessage = sentinel;
			error.content = [{ type: "text", text: sentinel }];
			error.responseId = sentinel;
			error.responseModel = sentinel;
			error.rawStopReason = sentinel;
			if (failure === "event") stream.push({ type: "error", reason: "error", error });
			stream.end(error);
			return stream;
		});
		if (failure === "auth") {
			transport.provider.auth.apiKey = {
				name: "test",
				resolve: async () => {
					throw new Error(sentinel);
				},
			};
		}
		const credentials: CredentialPort = {
			status: async () => {
				if (failure === "status") throw new Error(sentinel);
				return "configured";
			},
			get: async () => {
				if (failure === "get") throw new Error(sentinel);
				return sentinel;
			},
		};
		const models = createProductionModels(credentials, () => transport.provider);
		const model = models.getModels()[0];
		assert.ok(model);
		for (const stream of [models.stream(model, { messages: [] }), models.streamSimple(model, { messages: [] })]) {
			const events = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			assert.equal(result.stopReason, "error");
			assert.equal(
				readModelFailureDetail(result.errorMessage)?.category,
				failure === "status" || failure === "get" ? "credential_unavailable" : "model_request_failed",
			);
			assert.deepEqual(result.content, []);
			assert.equal(JSON.stringify({ events, result }).includes(sentinel), false);
			assert.equal(result.responseId, undefined);
		}
	});
}

test("abort reasons are sanitized and retain cancellation semantics", async () => {
	const transport = fixture(() => {
		throw new Error(sentinel);
	});
	const models = createProductionModels(configured, () => transport.provider);
	const model = models.getModels()[0];
	assert.ok(model);
	const controller = new AbortController();
	controller.abort(new Error(sentinel));
	const result = await models.completeSimple(model, { messages: [] }, { signal: controller.signal });
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, "model_request_aborted");
	assert.equal(JSON.stringify(result).includes(sentinel), false);
	assert.equal(transport.requests(), 0);
});

test("cancellation does not wait for a blocked credential host", { timeout: 1000 }, async () => {
	const entered = Promise.withResolvers<void>();
	const transport = fixture(() => {
		throw new Error("Must not dispatch");
	});
	const models = createProductionModels(
		{
			status: async () => {
				entered.resolve();
				return new Promise<"configured">(() => {});
			},
			get: async () => sentinel,
		},
		() => transport.provider,
	);
	const model = models.getModels()[0];
	assert.ok(model);
	const controller = new AbortController();
	const result = models.completeSimple(model, { messages: [] }, { signal: controller.signal });
	await entered.promise;
	controller.abort(new Error(sentinel));
	assert.equal((await result).stopReason, "aborted");
	assert.equal(transport.requests(), 0);
});

test("deferred cancellation errors expose no raw provider or credential causes", async () => {
	for (const failCredentials of [false, true]) {
		const transport = fixture(() => {
			throw new Error("Must not stream");
		});
		transport.provider.cancelDeferred = async () => {
			throw new Error(sentinel, { cause: { body: sentinel } });
		};
		const models = createProductionModels(
			{
				status: async () => {
					if (failCredentials) throw new Error(sentinel);
					return "configured";
				},
				get: async () => sentinel,
			},
			() => transport.provider,
		);
		const model = models.getModels()[0];
		assert.ok(model);
		await assert.rejects(
			models.cancelDeferred(model, {
				provider: model.provider,
				modelId: model.id,
				api: model.api,
				id: "fake-response",
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(error.message, "model_cancel_failed");
				assert.equal(error.cause, undefined);
				assert.equal(JSON.stringify(error).includes(sentinel), false);
				return true;
			},
		);
	}
});

for (const [code, category] of [
	[401, "model_auth_failed"],
	[429, "model_rate_limited"],
	["ECONNRESET", "model_network_failed"],
	[sentinel, "model_request_failed"],
] as const) {
	test(`only allowlisted structured diagnostic codes preserve category ${category}`, async () => {
		const transport = fixture(() => {
			const stream = createAssistantMessageEventStream();
			const error = message();
			error.stopReason = "error";
			error.errorMessage = sentinel;
			error.diagnostics = [
				{
					type: sentinel,
					timestamp: Date.now(),
					error: { code, message: sentinel, stack: sentinel },
					details: { body: sentinel },
				},
			];
			stream.push({ type: "error", reason: "error", error });
			stream.end();
			return stream;
		});
		const models = createProductionModels(configured, () => transport.provider);
		const model = models.getModels()[0];
		assert.ok(model);
		const result = await models.fetchDeferred(model, {
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			id: "fake-response",
		});
		assert.equal(readModelFailureDetail(result.errorMessage)?.category, category);
		assert.equal(readModelFailureDetail(result.errorMessage)?.dispatch, "unknown");
		assert.equal(JSON.stringify(result).includes(sentinel), false);
	});
}

for (const terminal of ["done", "result"] as const) {
	test(`successful ${terminal} results discard stale error diagnostics`, async () => {
		const transport = fixture(() => {
			const stream = createAssistantMessageEventStream();
			const result = message();
			result.errorMessage = sentinel;
			result.rawStopReason = sentinel;
			result.diagnostics = [{ type: sentinel, timestamp: Date.now(), error: { message: sentinel } }];
			if (terminal === "done") stream.push({ type: "done", reason: "stop", message: result });
			stream.end(result);
			return stream;
		});
		const models = createProductionModels(configured, () => transport.provider);
		const model = models.getModels()[0];
		assert.ok(model);
		const result = await models.completeSimple(model, { messages: [] });
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.content, message().content);
		assert.equal(JSON.stringify(result).includes(sentinel), false);
	});
}

test(
	"raw provider errors never enter Durable SQLite, snapshots, messages or receipts",
	{ timeout: 20_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-provider-redaction-"));
		const transport = fixture(() => {
			const stream = createAssistantMessageEventStream();
			const error = message();
			// A queued partial can alias the terminal message. Both paths must be isolated.
			stream.push({ type: "start", partial: error });
			error.stopReason = "error";
			error.errorMessage = sentinel;
			error.content = [{ type: "text", text: sentinel }];
			error.responseId = sentinel;
			error.rawStopReason = sentinel;
			stream.push({ type: "error", reason: "error", error });
			stream.end();
			return stream;
		});
		const models = createProductionModels(configured, () => transport.provider);
		const model = models.getModels()[0];
		assert.ok(model);
		const runtime = await openRuntime(directory, {
			models,
			credentials: configured,
			model: { provider: model.provider, modelId: model.id },
		});
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Redaction" });
			const created = await runtime.call("createConversation", {
				requestId: "create-1",
				workspaceId: "work",
				title: "Failure",
			});
			const scope = { workspaceId: "work", conversationId: created.conversationId };
			const frames: unknown[] = [];
			const observer = await runtime.observe(scope, (frame) => {
				frames.push(frame);
			});
			try {
				const submitted = await runtime.call("submit", { ...scope, requestId: "request_1", text: "Reply briefly" });
				const deadline = Date.now() + 10_000;
				let receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "request_1" });
				while (receipt?.execution !== "unanswered" && receipt?.execution !== "done" && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "request_1" });
				}
				assert.ok(receipt?.execution === "unanswered" || receipt?.execution === "done");
				const snapshot = await runtime.call("snapshot", scope);
				assert.equal(JSON.stringify({ submitted, receipt, snapshot, frames }).includes(sentinel), false);
				assert.equal(transport.requests(), 1, "unknown provider failures must not be retried");
			} finally {
				await observer.dispose();
			}
			await runtime.close();
			const entries = await readdir(directory, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const bytes = await readFile(join(entry.parentPath, entry.name));
				assert.equal(bytes.includes(Buffer.from(sentinel)), false, `Secret found in ${entry.name}`);
			}
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
