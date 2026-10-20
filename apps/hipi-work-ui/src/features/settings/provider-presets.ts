import type { CustomProviderConfiguration } from "@hipi/work-runtime/contracts";

/** Starting values mirror the installed Pi providers; they are not connectivity or model-availability claims. */
export const providerPresets: {
	id: string;
	name: string;
	protocol: CustomProviderConfiguration["protocol"];
	baseUrl: string;
}[] = [
	{ id: "openai", name: "OpenAI", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1" },
	{ id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	{ id: "deepseek", name: "DeepSeek", protocol: "openai-completions", baseUrl: "https://api.deepseek.com" },
	{ id: "openrouter", name: "OpenRouter", protocol: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
];
