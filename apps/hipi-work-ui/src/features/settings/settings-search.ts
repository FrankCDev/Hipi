import type { AppearanceStatus } from "@hipi/work-runtime/appearance";
import type { ModelCatalog } from "@hipi/work-runtime/contracts";
import type { ThemeConfig } from "../../app/theme/index.ts";
import { settingsLabels } from "./labels.ts";
import { providerLabels } from "./provider-labels.ts";
import { settingsPageLabels } from "./settings-page-labels.ts";

export type SettingsCategory = "general" | "appearance" | "models" | "runtime";
export type SettingsSearchEntry = {
	id: string;
	category: SettingsCategory;
	label: string;
	destination: string;
	description: string;
	value?: string;
	terms?: string;
};

/** Index only supported settings and returned model identities, never secrets or work content. */
export function settingsSearchEntries(
	config: ThemeConfig,
	catalog?: ModelCatalog,
	appearance?: AppearanceStatus,
): SettingsSearchEntry[] {
	const t = settingsLabels(config.locale);
	const l = settingsPageLabels(config.locale);
	const provider = providerLabels(config.locale);
	const entries: SettingsSearchEntry[] = [
		{
			id: "custom-providers",
			category: "models",
			label: provider["provider.title"],
			destination: l["settingsPage.models"],
			description: provider["provider.empty"],
			terms: "OpenAI Anthropic DeepSeek OpenRouter API base URL",
		},
		...(
			[
				"theme",
				"language",
				"uiFont",
				"codeFont",
				"contentFont",
				"uiFontSize",
				"codeFontSize",
				"reducedMotion",
				"separateModes",
				"transfer",
				"copyTheme",
				"installedFonts",
				"codeTheme",
				"pointerCursor",
			] as const
		).map((id) => {
			const key =
				id === "theme"
					? "theme"
					: id === "language"
						? "locale"
						: id === "transfer"
							? "importTheme"
							: id === "copyTheme"
								? "copy"
								: id;
			const value =
				id === "theme"
					? t(`settings.${config.mode}`)
					: id === "language"
						? config.locale === "en"
							? "English"
							: "简体中文"
						: id === "uiFont" || id === "codeFont" || id === "contentFont"
							? t(`settings.font.${config[id]}`)
							: undefined;
			return {
				id,
				category: id === "language" ? ("general" as const) : ("appearance" as const),
				label: t(`settings.${key}`),
				destination: l[id === "language" ? "settingsPage.general" : "settingsPage.appearance"],
				description: "",
				value,
			};
		}),
		...(["light", "dark"] as const).flatMap((mode) =>
			(["accent", "background", "foreground"] as const).map((field) => ({
				id: `${mode}-${field}`,
				category: "appearance" as const,
				label: `${t(`settings.${mode}`)} ${t(`settings.${field}`)}`,
				destination: l["settingsPage.appearance"],
				description: t("settings.visual"),
			})),
		),
		...(["providers", "credentials", "catalog"] as const).map((id) => ({
			id,
			category: "models" as const,
			label: l[`settingsPage.${id}`],
			destination: l["settingsPage.models"],
			description: id === "providers" ? l["settingsPage.providerNote"] : l[`settingsPage.${id}Note`],
			terms: id === "credentials" ? "OpenAI API key" : undefined,
		})),
		...(["connection", "workData", "localData", "appearanceData", "currentScope"] as const).map((id) => ({
			id,
			category: "runtime" as const,
			label: l[`settingsPage.${id}`],
			destination: l["settingsPage.runtime"],
			description: id === "currentScope" ? l["settingsPage.scopeNote"] : l[`settingsPage.${id}Note`],
		})),
	];
	for (const id of [
		...(appearance && appearance.backdrop !== "unsupported" ? ["translucentSidebar" as const] : []),
		...(appearance?.fontSmoothing ? ["fontSmoothing" as const] : []),
	]) {
		entries.push({
			id,
			category: "appearance",
			label: t(`settings.${id}`),
			destination: l["settingsPage.appearance"],
			description: "",
		});
	}
	for (const provider of catalog?.providers ?? []) {
		entries.push({
			id: `provider:${provider.provider}`,
			category: "models",
			label: provider.name,
			destination: l["settingsPage.models"],
			description: l["settingsPage.providers"],
			value: provider.provider,
		});
	}
	for (const model of catalog?.models ?? []) {
		entries.push({
			id: `model:${JSON.stringify([model.provider, model.modelId])}`,
			category: "models",
			label: model.name,
			destination: l["settingsPage.models"],
			description: `${model.provider} · ${model.modelId}`,
		});
	}
	return entries;
}

export function searchSettings(entries: SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
	const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
	if (!normalized) return [];
	const terms = normalized.split(/\s+/u);
	return entries
		.filter((entry) => {
			const text = [entry.label, entry.destination, entry.description, entry.value, entry.terms]
				.filter(Boolean)
				.join(" ")
				.normalize("NFKC")
				.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		})
		.sort(
			(a, b) =>
				Number(b.label.toLocaleLowerCase().includes(normalized)) -
				Number(a.label.toLocaleLowerCase().includes(normalized)),
		);
}
