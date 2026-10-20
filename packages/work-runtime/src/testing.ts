/** Explicit deterministic provider for tests and the local acceptance harness. Never a production default. */
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { LIMITS } from "./contracts.ts";
import { openRuntime, type RuntimeOptions } from "./node.ts";
export type DeterministicResponseFixture = "baseline-stream";
export function deterministicModels(tokensPerSecond = 40, fixture?: DeterministicResponseFixture): Models {
	if (fixture !== undefined && fixture !== "baseline-stream")
		throw new Error("Unknown deterministic response fixture");
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-faux",
		tokensPerSecond,
		tokenSize: { min: 1, max: 1 },
		models: [{ id: "faux-1", contextWindow: 2000000, maxTokens: 1024 }],
	});
	const answer = fauxAssistantMessage(
		fixture === "baseline-stream"
			? "Hipi Work deterministic test answer. No model API or external tool was called.\n\nThis second paragraph keeps the response open while the first paragraph is already settled."
			: "Hipi Work deterministic test answer. No model API or external tool was called.",
	);
	faux.setResponses(Array.from({ length: LIMITS.conversations * LIMITS.submissions * 2 }, () => answer));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}
export function openTestRuntime(
	directory: string,
	options: Omit<RuntimeOptions, "models" | "model"> & {
		tokensPerSecond?: number;
		responseFixture?: DeterministicResponseFixture;
	} = {},
) {
	const { tokensPerSecond, responseFixture, ...runtimeOptions } = options;
	return openRuntime(directory, {
		...runtimeOptions,
		models: deterministicModels(tokensPerSecond, responseFixture),
		model: { provider: "faux", modelId: "faux-1" },
	});
}
