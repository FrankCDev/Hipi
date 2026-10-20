/** Browser-safe, nonsecret provider settings. Credentials belong to the host credential service. */
export const CUSTOM_PROVIDER_LIMITS = {
	providers: 16,
	models: 16,
	builtInModels: 2048,
	name: 128,
	url: 2048,
	configurationBytes: 49152,
} as const;
export type CustomProviderProtocol = "openai-completions" | "anthropic-messages";
export type ProviderModelOption = { id: string; name: string };
export type CustomProviderConfiguration = {
	/** Runtime-generated recipient identity. A different endpoint or protocol always gets a new identity. */
	provider: string;
	/** User-visible vendor identifier; not a credential key or authorization identity. */
	vendorId: string;
	name: string;
	protocol: CustomProviderProtocol;
	baseUrl: string;
	models: ProviderModelOption[];
};
export type ProviderConfigurationMethods = {
	listCustomProviders: { params: Record<string, never>; result: { providers: CustomProviderConfiguration[] } };
	saveCustomProvider: {
		params: Omit<CustomProviderConfiguration, "provider"> & { provider?: string; requestId: string };
		result: CustomProviderConfiguration;
	};
	removeCustomProvider: {
		params: { provider: string; requestId: string };
		result: { provider: string; removed: true };
	};
	listBuiltInProviders: { params: Record<string, never>; result: { providers: { vendorId: string; name: string }[] } };
	getBuiltInProviderModels: {
		params: { vendorId: string };
		result: { vendorId: string; models: ProviderModelOption[] };
	};
};
type Method = keyof ProviderConfigurationMethods;
function invalid(): never {
	throw new Error("INVALID_REQUEST");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	if (
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
		Object.getOwnPropertySymbols(value).length ||
		Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor))
	)
		return invalid();
	return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function text(value: unknown, max: number): string {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > max ||
		value !== value.trim() ||
		/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)
	)
		return invalid();
	return value;
}
function identifier(value: unknown): string {
	const result = text(value, 128);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) invalid();
	return result;
}
export function customProviderId(value: unknown): string {
	const result = text(value, 71);
	if (!/^custom_[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) invalid();
	return result;
}
/** Preserve gateway path prefixes. Only URL normalization and trailing slashes are canonicalized. */
export function normalizeProviderBaseUrl(value: unknown): string {
	const raw = text(value, CUSTOM_PROVIDER_LIMITS.url);
	if (/[\s\\?#]/u.test(raw) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) invalid();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return invalid();
	}
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) invalid();
	if (
		url.protocol === "http:" &&
		url.hostname !== "localhost" &&
		url.hostname !== "[::1]" &&
		!/^127(?:\.\d{1,3}){3}$/.test(url.hostname)
	)
		invalid();
	return url.href.replace(/\/+$/, "");
}
function models(value: unknown, max: number): ProviderModelOption[] {
	if (!Array.isArray(value) || value.length > max) return invalid();
	const result = Array.from(value, (entry) => {
		const input = object(entry);
		fields(input, ["id", "name"]);
		return { id: text(input.id, 256), name: text(input.name, 256) };
	});
	if (new Set(result.map((entry) => entry.id)).size !== result.length) invalid();
	return result;
}
function configuration(value: Record<string, unknown>): Omit<CustomProviderConfiguration, "provider"> {
	if (value.protocol !== "openai-completions" && value.protocol !== "anthropic-messages") return invalid();
	const entries = models(value.models, CUSTOM_PROVIDER_LIMITS.models);
	if (!entries.length) invalid();
	const baseUrl = normalizeProviderBaseUrl(value.baseUrl);
	const path = new URL(baseUrl).pathname;
	if (value.protocol === "anthropic-messages" ? /\/(?:v1|messages)$/.test(path) : /\/chat\/completions$/.test(path))
		invalid();
	return {
		vendorId: identifier(value.vendorId),
		name: text(value.name, CUSTOM_PROVIDER_LIMITS.name),
		protocol: value.protocol,
		baseUrl,
		models: entries,
	};
}
export function parseCustomProviderConfiguration(value: unknown): CustomProviderConfiguration {
	const input = object(value);
	fields(input, ["provider", "vendorId", "name", "protocol", "baseUrl", "models"]);
	const result = { provider: customProviderId(input.provider), ...configuration(input) };
	if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CUSTOM_PROVIDER_LIMITS.configurationBytes)
		invalid();
	return result;
}
export function isProviderConfigurationMethod(value: unknown): value is Method {
	return (
		value === "listCustomProviders" ||
		value === "saveCustomProvider" ||
		value === "removeCustomProvider" ||
		value === "listBuiltInProviders" ||
		value === "getBuiltInProviderModels"
	);
}
export function parseProviderConfigurationParams<M extends Method>(
	method: M,
	value: unknown,
): ProviderConfigurationMethods[M]["params"] {
	const input = object(value);
	let result: ProviderConfigurationMethods[Method]["params"];
	if (method === "listCustomProviders" || method === "listBuiltInProviders") {
		fields(input, []);
		result = {};
	} else if (method === "getBuiltInProviderModels") {
		fields(input, ["vendorId"]);
		result = { vendorId: identifier(input.vendorId) };
	} else if (method === "removeCustomProvider") {
		fields(input, ["provider", "requestId"]);
		result = { provider: customProviderId(input.provider), requestId: identifier(input.requestId) };
	} else {
		fields(input, ["provider", "requestId", "vendorId", "name", "protocol", "baseUrl", "models"]);
		result = {
			...configuration(input),
			requestId: identifier(input.requestId),
			...(input.provider === undefined ? {} : { provider: customProviderId(input.provider) }),
		};
	}
	return result as ProviderConfigurationMethods[M]["params"];
}
export function parseProviderConfigurationResult<M extends Method>(
	method: M,
	value: unknown,
): ProviderConfigurationMethods[M]["result"] {
	const input = object(value);
	let result: ProviderConfigurationMethods[Method]["result"];
	if (method === "saveCustomProvider") result = parseCustomProviderConfiguration(input);
	else if (method === "removeCustomProvider") {
		fields(input, ["provider", "removed"]);
		if (input.removed !== true) invalid();
		result = { provider: customProviderId(input.provider), removed: true };
	} else if (method === "getBuiltInProviderModels") {
		fields(input, ["vendorId", "models"]);
		result = {
			vendorId: identifier(input.vendorId),
			models: models(input.models, CUSTOM_PROVIDER_LIMITS.builtInModels),
		};
	} else {
		fields(input, ["providers"]);
		if (!Array.isArray(input.providers)) return invalid();
		if (method === "listCustomProviders") {
			if (input.providers.length > CUSTOM_PROVIDER_LIMITS.providers) invalid();
			const providers = Array.from(input.providers, parseCustomProviderConfiguration);
			if (new Set(providers.map((entry) => entry.provider)).size !== providers.length) invalid();
			result = { providers };
		} else {
			if (input.providers.length > 128) invalid();
			const providers = Array.from(input.providers, (entry) => {
				const vendor = object(entry);
				fields(vendor, ["vendorId", "name"]);
				return { vendorId: identifier(vendor.vendorId), name: text(vendor.name, 256) };
			});
			if (new Set(providers.map((entry) => entry.vendorId)).size !== providers.length) invalid();
			result = { providers };
		}
	}
	return result as ProviderConfigurationMethods[M]["result"];
}
