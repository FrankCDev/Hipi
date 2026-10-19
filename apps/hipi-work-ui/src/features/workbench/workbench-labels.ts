const en = {
	"workbench.modelStatus": "Model status",
} as const;
const zh: Record<keyof typeof en, string> = {
	"workbench.modelStatus": "模型状态",
};
export function workbenchLabels(locale: string) {
	return locale === "en" ? en : zh;
}
