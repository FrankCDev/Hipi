const en = {
	title: "Recover earlier drafts",
	description:
		"Earlier unsent drafts were kept separately. Recovering text keeps your current project selection, preserves the current draft, and sends nothing.",
	projectless: "No project",
	unknown: "Original project unavailable. Recovery keeps your current project selection.",
	recover: "Recover text into current selection",
	recoverCurrent: "Recover draft into current selection",
	claimed:
		"This draft belongs to an unresolved first Send. Later saved text is shown here; resolve the original request before recovering it.",
	failed:
		"The draft could not be safely restored. Your text is preserved. Retry after checking the other window or storage availability.",
	retry: "Reload saved draft",
};
const zh: typeof en = {
	title: "恢复之前的草稿",
	description: "之前未发送的草稿已分别保留。恢复文本时保留当前选择的项目，不会覆盖当前草稿，也不会发送消息。",
	projectless: "不关联项目",
	unknown: "原项目未知。恢复时保留当前选择的项目。",
	recover: "将文本恢复到当前选择",
	recoverCurrent: "将草稿恢复到当前选择",
	claimed: "此草稿属于尚未确认的首次发送。这里保留了之后保存的文本；请先处理原请求，再恢复草稿。",
	failed: "无法安全恢复草稿。文本已保留，请检查其他窗口或存储状态后重试。",
	retry: "重新载入已保存草稿",
};
export function draftLabels(locale: string) {
	return locale === "en" ? en : zh;
}
