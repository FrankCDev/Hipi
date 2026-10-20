const en = {
	collapseLabel: (label: string) => `Collapse ${label}`,
	expandLabel: (label: string) => `Expand ${label}`,
	failed: "Could not save this sidebar section change. Your previous view is unchanged.",
	stale: "This sidebar section changed in another window. Review its current state before changing it again.",
	incompatible: "Saved sidebar section states cannot be read. They have been preserved.",
	retry: "Retry section change",
	refresh: "Reload sidebar sections",
};
const zh: typeof en = {
	collapseLabel: (label: string) => `收起${label}`,
	expandLabel: (label: string) => `展开${label}`,
	failed: "无法保存侧边栏分区更改，原显示状态保持不变。",
	stale: "此侧边栏分区已在其他窗口更改，请核对当前状态后再更改。",
	incompatible: "无法读取已保存的侧边栏分区状态，原始数据已保留。",
	retry: "重试分区更改",
	refresh: "重新读取侧边栏分区",
};
export const sidebarSectionLabels = (locale: string) => (locale === "en" ? en : zh);
