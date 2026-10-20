import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type CredentialStore,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	envApiKeyAuth,
	type FetchFunction,
	type Model,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AppError, type CredentialState, type CustomProviderConfiguration, type Result } from "./contracts.ts";
import { type ModelFailure, type ModelFailureCategory, modelFailureDetail } from "./model-failure.ts";
import { parseCustomProviderConfiguration } from "./provider-configuration.ts";

type RegisteredConfiguration = {
	value: CustomProviderConfiguration;
	provider: Provider;
	models: Model<Api>[];
	controllers: Map<string, AbortController>;
};
const configuredCollections = new WeakMap<
	Models,
	{
		models: MutableModels;
		providers: Map<string, RegisteredConfiguration>;
	}
>();

/** Static bundled model suggestions only. Never refreshes, resolves auth, or contacts vendors. */
export function builtInProviderCatalog(): Result<"listBuiltInProviders"> {
	return { providers: getBuiltinProviders().map((vendorId) => ({ vendorId, name: vendorId })) };
}
export function builtInProviderModels(vendorId: string): Result<"getBuiltInProviderModels"> {
	const known = getBuiltinProviders().find((entry) => entry === vendorId);
	if (!known) throw new AppError("NOT_FOUND");
	return { vendorId, models: getBuiltinModels(known).map((model) => ({ id: model.id, name: model.name })) };
}
export function assertConfigurableModels(models: Models): void {
	if (!configuredCollections.has(models)) throw new AppError("MODEL_UNAVAILABLE");
}
/** Only providers created at this trusted runtime boundary may introduce a new network recipient. */
export function registeredCustomProvider(models: Models, id: string): Provider | undefined {
	const entry = configuredCollections.get(models)?.providers.get(id);
	return entry && models.getProvider(id) === entry.provider ? entry.provider : undefined;
}
export function customModelRequestUrl(model: Model<Api>): string {
	return `${model.baseUrl}${model.api === "anthropic-messages" ? "/v1/messages?beta=true" : "/chat/completions"}`;
}
function configurationModels(value: CustomProviderConfiguration): Model<Api>[] {
	return value.models.map((model) => ({
		id: model.id,
		name: model.name,
		provider: value.provider,
		api: value.protocol,
		baseUrl: value.baseUrl,
		input: ["text"],
		reasoning: false,
		contextWindow: 32768,
		maxTokens: 4096,
		// Pi requires numeric rates. These placeholders are not advertised pricing.
		// Public settings expose no price or verified model-limit claim.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}
/** Publish only after the catalog transaction commits. No auth resolution or network occurs here. */
export function configureCustomProviders(models: Models, values: readonly CustomProviderConfiguration[]): void {
	const collection = configuredCollections.get(models);
	if (!collection) {
		if (values.length) throw new AppError("MODEL_UNAVAILABLE");
		return;
	}
	const parsed = values.map(parseCustomProviderConfiguration);
	for (const value of parsed) {
		const previous = collection.providers.get(value.provider);
		if (previous && (previous.value.baseUrl !== value.baseUrl || previous.value.protocol !== value.protocol))
			throw new AppError("INVALID_REQUEST");
	}
	for (const [id, previous] of collection.providers) {
		if (parsed.some((value) => value.provider === id)) continue;
		for (const controller of previous.controllers.values()) controller.abort();
		collection.models.deleteProvider(id);
		collection.providers.delete(id);
	}
	for (const value of parsed) {
		const previous = collection.providers.get(value.provider);
		if (previous) {
			for (const [id, controller] of previous.controllers) {
				if (value.models.some((model) => model.id === id)) continue;
				controller.abort();
				previous.controllers.delete(id);
			}
			for (const model of value.models)
				if (!previous.controllers.has(model.id)) previous.controllers.set(model.id, new AbortController());
			previous.value = value;
			previous.models.splice(0, previous.models.length, ...configurationModels(value));
			continue;
		}
		const entries = configurationModels(value);
		const transport = createProvider({
			id: value.provider,
			name: value.name,
			baseUrl: value.baseUrl,
			auth: { apiKey: envApiKeyAuth(value.name, []) },
			models: entries,
			api: value.protocol === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
		});
		const provider: Provider = {
			...transport,
			get name() {
				return registration.value.name;
			},
		};
		const registration: RegisteredConfiguration = {
			value,
			provider,
			models: entries,
			controllers: new Map(entries.map((model) => [model.id, new AbortController()])),
		};
		collection.providers.set(value.provider, registration);
		collection.models.setProvider(provider);
	}
}

/** Private host capability. Never expose this port through the application client. */
export interface CredentialPort {
	status(provider: string): Promise<CredentialState>;
	get(provider: string): Promise<string | undefined>;
}

function failureCategory(message: AssistantMessage): ModelFailureCategory {
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
	start: (
		key: string,
		evidence: { dispatch: ModelFailure["dispatch"]; category?: ModelFailureCategory },
	) => AssistantMessageEventStream,
	signal?: AbortSignal,
	isAvailable: () => boolean = () => true,
	initialDispatch: ModelFailure["dispatch"] = "not_sent",
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const timestamp = Date.now();
	const evidence: { dispatch: ModelFailure["dispatch"]; category?: ModelFailureCategory } = { dispatch: "not_sent" };
	const fail = (aborted: boolean, category: ModelFailureCategory = "model_request_failed") => {
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
			errorMessage: aborted
				? "model_request_aborted"
				: modelFailureDetail(evidence.category ?? category, evidence.dispatch),
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
			if (!isAvailable()) {
				fail(false, "model_unavailable");
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
			if (!isAvailable()) {
				fail(false, "model_unavailable");
				return;
			}
			resolvingCredentials = false;
			evidence.dispatch = initialDispatch;
			const source = start(key, evidence);
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

/** Explicit host credentials and pre-persistence error isolation for official and configured transports. */
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
	configuredCollections.set(models, { models, providers: new Map() });
	const transportOptions = (
		model: Model<Api>,
		fetch: FetchFunction | undefined,
		signal: AbortSignal | undefined,
		evidence: { dispatch: ModelFailure["dispatch"]; category?: ModelFailureCategory },
	) => {
		const entry = configuredCollections.get(models)?.providers.get(model.provider);
		const custom = model.provider.startsWith("custom_");
		const available = () => {
			const current = models.getModel(model.provider, model.id);
			return Boolean(
				entry?.controllers.has(model.id) &&
					!entry.controllers.get(model.id)?.signal.aborted &&
					registeredCustomProvider(models, model.provider) === entry.provider &&
					current &&
					current.api === model.api &&
					current.baseUrl === model.baseUrl &&
					!model.headers,
			);
		};
		const controllerSignal = custom ? (entry?.controllers.get(model.id)?.signal ?? AbortSignal.abort()) : undefined;
		const combined =
			signal && controllerSignal ? AbortSignal.any([signal, controllerSignal]) : (signal ?? controllerSignal);
		return {
			signal: combined,
			fetch: (async (input, init) => {
				if (custom && !available()) {
					evidence.category = "model_unavailable";
					throw new Error("model_unavailable");
				}
				if (custom) {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					const method = init?.method ?? (input instanceof Request ? input.method : "GET");
					if (url.href !== customModelRequestUrl(model) || method.toUpperCase() !== "POST") {
						evidence.category = "model_unavailable";
						throw new Error("model_unavailable");
					}
				}
				const signals: AbortSignal[] = combined ? [combined] : [];
				if (init?.signal) signals.push(init.signal);
				if (input instanceof Request) signals.push(input.signal);
				evidence.dispatch = "attempted";
				let response: Response;
				try {
					response = await (fetch ?? globalThis.fetch)(input, {
						...init,
						redirect: "error",
						signal: AbortSignal.any(signals),
					});
				} catch {
					evidence.category = "model_network_failed";
					throw new Error("model_network_failed");
				}
				if (!response.ok) {
					evidence.category =
						response.status === 401 || response.status === 403
							? "model_auth_failed"
							: response.status === 429
								? "model_rate_limited"
								: response.status === 404
									? "model_unavailable"
									: response.status >= 500
										? "model_service_unavailable"
										: response.status >= 400
											? "model_request_rejected"
											: "model_request_failed";
				}
				return response;
			}) satisfies FetchFunction,
		};
	};
	const available = (model: Model<Api>) =>
		!model.provider.startsWith("custom_") ||
		Boolean(
			registeredCustomProvider(models, model.provider) &&
				models.getModel(model.provider, model.id)?.baseUrl === model.baseUrl &&
				models.getModel(model.provider, model.id)?.api === model.api &&
				!model.headers,
		);
	// Wrap the collection, not just the provider: createModels resolves auth outside provider streams.
	const stream = models.stream.bind(models);
	const streamSimple = models.streamSimple.bind(models);
	const streamDeferred = models.streamDeferred.bind(models);
	const cancelDeferred = models.cancelDeferred.bind(models);
	models.stream = (model, context, options) =>
		sanitizedStream(
			model,
			credentials,
			(key, evidence) =>
				stream<Api>(model, context, {
					...options,
					...transportOptions(model, options?.fetch, options?.signal, evidence),
					transport: "sse",
					apiKey: key,
					env: undefined,
					maxRetries: 0,
					timeoutMs: 120_000,
				}),
			options?.signal,
			() =>
				available(model) &&
				(!model.provider.startsWith("custom_") || !(options && "deferred" in options && options.deferred)),
		);
	models.streamSimple = (model, context, options) =>
		sanitizedStream(
			model,
			credentials,
			(key, evidence) =>
				streamSimple(model, context, {
					...options,
					...transportOptions(model, options?.fetch, options?.signal, evidence),
					transport: "sse",
					apiKey: key,
					env: undefined,
					maxRetries: 0,
					timeoutMs: 120_000,
				}),
			options?.signal,
			() => available(model) && (!model.provider.startsWith("custom_") || !options?.deferred),
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
			() => !model.provider.startsWith("custom_"),
			"unknown",
		);
	models.cancelDeferred = async (model, handle, options) => {
		try {
			if (model.provider.startsWith("custom_")) throw new Error("model_operation_not_supported");
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
