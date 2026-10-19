/** Explicit deterministic provider for tests and the local acceptance harness. Never a production default. */
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { LIMITS } from "./contracts.ts";
import { openRuntime, type RuntimeOptions } from "./node.ts";
export function deterministicModels(tokensPerSecond = 40): Models {
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-faux",
		tokensPerSecond,
		tokenSize: { min: 1, max: 1 },
		models: [{ id: "faux-1", contextWindow: 2000000, maxTokens: 1024 }],
	});
	const answer = fauxAssistantMessage(
		"Hipi Work deterministic test answer. No model API or external tool was called.",
	);
	faux.setResponses(Array.from({ length: LIMITS.conversations * LIMITS.submissions * 2 }, () => answer));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
export function openTestRuntime(
	directory: string,
	options: Omit<RuntimeOptions, "models" | "model"> & { tokensPerSecond?: number } = {},
) {
	return openRuntime(directory, {
		...options,
		models: deterministicModels(options.tokensPerSecond),
		model: { provider: "faux", modelId: "faux-1" },
	});
}
