import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type CredentialStore,
	createAssistantMessageEventStream,
	createModels,
	type Model,
	type Models,
	type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { CredentialState } from "./contracts.ts";

/** Private host capability. Never expose this port through the application client. */
export interface CredentialPort {
	status(provider: string): Promise<CredentialState>;
	get(provider: string): Promise<string | undefined>;
}

type FailureCategory =
	| "model_request_failed"
	| "model_auth_failed"
	| "model_rate_limited"
	| "model_network_failed"
	| "credential_required"
	| "credential_locked"
	| "credential_unavailable";

function failureCategory(message: AssistantMessage): FailureCategory {
	for (const diagnostic of message.diagnostics ?? []) {
		const code = diagnostic.error?.code;
		if (code === 401 || code === 403 || code === "invalid_api_key" || code === "authentication_error")
			return "model_auth_failed";
		if (code === 429 || code === "rate_limit_exceeded") return "model_rate_limited";
		if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return "model_network_failed";
	}
	return "model_request_failed";
}

function cleanMessage(message: AssistantMessage): AssistantMessage {
	const copy = structuredClone(message);
	delete copy.errorMessage;
	delete copy.diagnostics;
	delete copy.rawStopReason;
	return copy;
}

async function awaitCredential<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("model_request_aborted"));
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			() => {
				signal.removeEventListener("abort", abort);
				reject(new Error("credential_unavailable"));
			},
		);
		if (signal.aborted) {
			signal.removeEventListener("abort", abort);
			abort();
		}
	});
}

function sanitizedStream(
	model: Model<Api>,
	credentials: CredentialPort,
	start: (key: string) => AssistantMessageEventStream,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const timestamp = Date.now();
	const fail = (aborted: boolean, category: FailureCategory = "model_request_failed") => {
		// Reconstruct rather than redact: providers may attach secrets anywhere in an error message.
		const error: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: aborted ? "aborted" : "error",
			errorMessage: aborted ? "model_request_aborted" : category,
			timestamp,
		};
		output.push({ type: "error", reason: aborted ? "aborted" : "error", error });
		output.end(error);
	};
	void (async () => {
		let resolvingCredentials = true;
		try {
			if (signal?.aborted) {
				fail(true);
				return;
			}
			const status = await awaitCredential(credentials.status(model.provider), signal);
			if (status !== "configured") {
				fail(
					signal?.aborted === true,
					status === "missing"
						? "credential_required"
						: status === "locked"
							? "credential_locked"
							: "credential_unavailable",
				);
				return;
			}
			const key = await awaitCredential(credentials.get(model.provider), signal);
			if (!key) {
				fail(signal?.aborted === true, "credential_required");
				return;
			}
			resolvingCredentials = false;
			const source = start(key);
			for await (const event of source) {
				if (event.type === "error") {
					fail(event.reason === "aborted" || signal?.aborted === true, failureCategory(event.error));
					return;
				}
				if (event.type === "done") {
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
						fail(
							event.message.stopReason === "aborted" || signal?.aborted === true,
							failureCategory(event.message),
						);
					} else {
						output.push({ ...event, message: cleanMessage(event.message) });
						output.end();
					}
					return;
				}
				if (event.partial.stopReason === "error" || event.partial.stopReason === "aborted") {
					fail(event.partial.stopReason === "aborted" || signal?.aborted === true, failureCategory(event.partial));
					return;
				}
				// Providers mutate their partial message while streaming. Do not retain an alias that
				// may later acquire the raw terminal failure before Durable serializes the event.
				const copy = structuredClone(event);
				copy.partial = cleanMessage(copy.partial);
				output.push(copy);
			}
			const result = await source.result();
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				fail(result.stopReason === "aborted" || signal?.aborted === true, failureCategory(result));
			} else {
				output.end(cleanMessage(result));
			}
		} catch {
			// Includes synchronous setup, credential/auth resolution, and iterator failures.
			fail(signal?.aborted === true, resolvingCredentials ? "credential_unavailable" : "model_request_failed");
		}
	})();
	return output;
}

/** Official OpenAI transport with explicit credentials and pre-persistence stream error isolation. */
export function createProductionModels(
	credentials: CredentialPort,
	providerFactory: () => Provider = openaiProvider,
): Models {
	const store: CredentialStore = {
		async read(provider) {
			if ((await credentials.status(provider)) !== "configured") return undefined;
			const key = await credentials.get(provider);
			return key ? { type: "api_key", key } : undefined;
		},
		async list() {
			return (await credentials.status("openai")) === "configured"
				? [{ providerId: "openai", type: "api_key" }]
				: [];
		},
		async modify() {
			throw new Error("credential_mutation_requires_host");
		},
		async delete() {
			throw new Error("credential_mutation_requires_host");
		},
	};
	const models = createModels({
		credentials: store,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(providerFactory());
	// Wrap the collection, not just the provider: createModels resolves auth outside provider streams.
	const stream = models.stream.bind(models);
	const streamSimple = models.streamSimple.bind(models);
	const streamDeferred = models.streamDeferred.bind(models);
	const cancelDeferred = models.cancelDeferred.bind(models);
	models.stream = (model, context, options) =>
		sanitizedStream(
			model,
			credentials,
			(key) =>
				stream<Api>(model, context, {
					...options,
					apiKey: key,
					env: undefined,
					maxRetries: 0,
					timeoutMs: 120_000,
				}),
			options?.signal,
		);
	models.streamSimple = (model, context, options) =>
		sanitizedStream(
			model,
			credentials,
			(key) =>
				streamSimple(model, context, {
					...options,
					apiKey: key,
					env: undefined,
					maxRetries: 0,
					timeoutMs: 120_000,
				}),
			options?.signal,
		);
	models.streamDeferred = (model, handle, options) =>
		sanitizedStream(
			model,
			credentials,
			(key) =>
				streamDeferred(model, handle, {
					...options,
					apiKey: key,
					env: undefined,
					maxRetries: 0,
					timeoutMs: 120_000,
				}),
			options?.signal,
		);
	models.cancelDeferred = async (model, handle, options) => {
		try {
			await cancelDeferred(model, handle, {
				...options,
				apiKey: undefined,
				env: undefined,
				maxRetries: 0,
				timeoutMs: 120_000,
			});
		} catch {
			// Durable reports deferred cancellation exceptions through its diagnostic channel.
			throw new Error(options?.signal?.aborted ? "model_request_aborted" : "model_cancel_failed");
		}
	};
	// Models' completion methods call these wrapped stream methods via `this`.
	return models;
}
