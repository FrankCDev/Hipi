import type { ModelCatalog } from "@hipi/work-runtime/contracts";
import type { ThemeConfig } from "../../app/theme/index.ts";
import { settingsLabels } from "./labels.ts";
import { settingsPageLabels } from "./settings-page-labels.ts";

export type SettingsCategory = "appearance" | "models" | "runtime";
export type SettingsSearchEntry = {
	id: string;
	category: SettingsCategory;
	label: string;
	destination: string;
	description: string;
	value?: string;
	terms?: string;
};

/** Index only settings the current UI actually exposes; never credentials or user work content. */
export function settingsSearchEntries(config: ThemeConfig, catalog?: ModelCatalog): SettingsSearchEntry[] {
	const t = settingsLabels(config.locale);
	const l = settingsPageLabels(config.locale);
	const entries: SettingsSearchEntry[] = [
		...(["theme", "language", "uiFont", "codeFont", "regions", "transfer"] as const).map((id) => {
			const label = id === "theme" ? "mode" : id === "language" ? "locale" : id;
			const value =
				id === "theme"
					? t(`settings.${config.mode}`)
					: id === "language"
						? config.locale === "en"
							? "English"
							: "简体中文"
						: id === "uiFont" || id === "codeFont"
							? t(`settings.font.${config[id]}`)
							: undefined;
			return {
				id,
				category: "appearance" as const,
				label: t(`settings.${label}`),
				destination: l["settingsPage.appearance"],
				description: t(`settings.${label}Description`),
				value,
				terms:
					id === "transfer"
						? [t("settings.reset"), t("settings.import"), t("settings.export"), "JSON"].join(" ")
						: id === "regions"
							? [
									t("settings.foreground"),
									t("settings.background"),
									...(["sidebar", "messages", "editor"] as const).map((region) => t(`settings.region.${region}`)),
								].join(" ")
							: undefined,
			};
		}),
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
