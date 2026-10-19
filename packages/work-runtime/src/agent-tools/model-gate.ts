import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type FetchFunction,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { type PackageDescriptor, packageDescriptors } from "../extensions/lifecycle-descriptors.ts";

/** Host-only port. Implementations share their conversation lock with revocation. */
export interface ModelDispatchAuthorization {
	check(sessionId: string, model: Model<Api>, descriptors?: readonly PackageDescriptor[]): Promise<void>;
	/**
	 * Re-read committed authorization, register controller, then invoke dispatch synchronously
	 * under the revocation lock. Box the response promise: never hold that lock over network IO.
	 * release unregisters the controller after the entire response stream terminates.
	 */
	start(
		sessionId: string,
		model: Model<Api>,
		controller: AbortController,
		dispatch: () => Promise<Response>,
		descriptors?: readonly PackageDescriptor[],
	): Promise<{ response: Promise<Response>; release: () => void }>;
}

function failure(model: Model<Api>, aborted: boolean): AssistantMessage {
	return {
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
		errorMessage: aborted ? "model_request_aborted" : "model_context_blocked",
		timestamp: Date.now(),
	};
}

/** A workspace-owned facade; never patches the shared collection or binds its completions. */
export function createWorkspaceModels(
	models: Models,
	authorization: ModelDispatchAuthorization,
	fetchImplementation: FetchFunction = globalThis.fetch,
): Models {
	const providers = new Map(models.getProviders().map((provider) => [provider.id, provider]));
	const guarded = (
		model: Model<Api>,
		sessionId: string | undefined,
		signal: AbortSignal | undefined,
		deferred: unknown,
		context: Context,
		start: (
			fetch: FetchFunction,
			signal: AbortSignal,
			model: Model<Api>,
			context: Context,
		) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const output = createAssistantMessageEventStream();
		const controller = new AbortController();
		const releases = new Set<() => void>();
		let ended = false;
		let denied = false;
		const requestModel = structuredClone(model);
		// The evidence and the provider request share this owned snapshot, including system tool deltas.
		const requestContext = structuredClone(context);
		const descriptors = packageDescriptors(requestContext);
		const assertProvider = () => {
			if (
				!providers.has(requestModel.provider) ||
				models.getProvider(requestModel.provider) !== providers.get(requestModel.provider)
			) {
				throw new Error("model_context_blocked");
			}
		};
		const cleanup = () => {
			ended = true;
			signal?.removeEventListener("abort", abort);
			controller.signal.removeEventListener("abort", cancelled);
			for (const release of releases) release();
			releases.clear();
		};
		const fail = (aborted: boolean) => {
			if (ended) return;
			const error = failure(requestModel, aborted);
			output.push({ type: "error", reason: aborted ? "aborted" : "error", error });
			output.end(error);
			cleanup();
		};
		const abort = () => controller.abort();
		const cancelled = () => fail(true);
		controller.signal.addEventListener("abort", cancelled, { once: true });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const fetch: FetchFunction = async (input, init) => {
			try {
				if (!sessionId || ended || controller.signal.aborted) throw new Error("model_context_blocked");
				assertProvider();
				// This is the HTTP boundary, after credential resolution and payload assembly.
				const dispatch = await authorization.start(
					sessionId,
					requestModel,
					controller,
					() => {
						assertProvider();
						controller.signal.throwIfAborted();
						const url = new URL(input instanceof Request ? input.url : input.toString());
						const method = init?.method ?? (input instanceof Request ? input.method : "GET");
						if (
							url.origin !== "https://api.openai.com" ||
							url.username ||
							url.password ||
							url.search ||
							url.hash ||
							!["/v1/responses", "/v1/chat/completions"].includes(url.pathname) ||
							method.toUpperCase() !== "POST" ||
							requestModel.provider !== "openai" ||
							!["openai-responses", "openai-completions"].includes(requestModel.api)
						) {
							throw new Error("model_context_blocked");
						}
						const signals = [controller.signal];
						if (init?.signal) signals.push(init.signal);
						if (input instanceof Request) signals.push(input.signal);
						return fetchImplementation(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
					},
					descriptors,
				);
				if (ended) dispatch.release();
				else releases.add(dispatch.release);
				return dispatch.response;
			} catch {
				denied = true;
				throw new Error("model_context_blocked");
			}
		};
		void (async () => {
			try {
				if (ended) return;
				if (!sessionId || deferred) throw new Error("model_context_blocked");
				assertProvider();
				await authorization.check(sessionId, requestModel, descriptors);
				if (ended) return;
				assertProvider();
				const source = start(fetch, controller.signal, requestModel, requestContext);
				for await (const event of source) {
					if (ended) return;
					if (denied) {
						fail(controller.signal.aborted);
						return;
					}
					output.push(event);
				}
				if (!ended) {
					if (denied) fail(controller.signal.aborted);
					else {
						output.end(await source.result());
						cleanup();
					}
				}
			} catch {
				fail(controller.signal.aborted);
			}
		})();
		return output;
	};
	const unsupported = () => {
		throw new Error("model_operation_not_supported");
	};
	const facade: Models = {
		getProviders: models.getProviders.bind(models),
		getProvider: models.getProvider.bind(models),
		getModels: models.getModels.bind(models),
		getModel: models.getModel.bind(models),
		getModelsOfType: models.getModelsOfType.bind(models),
		getModelOfType: models.getModelOfType.bind(models),
		getAllModels: models.getAllModels.bind(models),
		refresh: models.refresh.bind(models),
		checkAuth: models.checkAuth.bind(models),
		getAvailable: models.getAvailable.bind(models),
		getAvailableOfType: models.getAvailableOfType.bind(models),
		getAllAvailable: models.getAllAvailable.bind(models),
		getAuth: models.getAuth.bind(models),
		login: models.login.bind(models),
		logout: models.logout.bind(models),
		stream: (model, context, options) =>
			guarded(
				model,
				options?.sessionId,
				options?.signal,
				options && "deferred" in options ? options.deferred : undefined,
				context,
				(fetch, signal, snapshot, requestContext) =>
					models.stream(snapshot, requestContext, { ...options, fetch, signal, transport: "sse" }),
			),
		streamSimple: (model, context, options) =>
			guarded(
				model,
				options?.sessionId,
				options?.signal,
				options?.deferred,
				context,
				(fetch, signal, snapshot, requestContext) =>
					models.streamSimple(snapshot, requestContext, {
						...options,
						fetch,
						signal,
						transport: "sse",
						deferred: false,
					}),
			),
		complete: (model, context, options) => facade.stream(model, context, options).result(),
		completeSimple: (model, context, options) => facade.streamSimple(model, context, options).result(),
		streamDeferred: unsupported,
		fetchDeferred: async () => unsupported(),
		cancelDeferred: async () => unsupported(),
		generateImages: async () => unsupported(),
		classify: async () => unsupported(),
	};
	return facade;
}
