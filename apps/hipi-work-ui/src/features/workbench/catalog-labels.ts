const en = {
	first: "First page",
	next: "Next page",
	active: "Active conversations",
	archived: "Archived conversations",
	filter: "Conversation list",
	loaded: "On this page",
	rename: "Rename conversation",
	archive: "Archive conversation",
	restore: "Restore conversation",
	confirm: "Confirm",
	close: "Close",
	title: "Title",
	pending: "A directory command has an unconfirmed result. Its original request is saved; do not create a replacement.",
	check: "Check original request",
	retry: "Retry unchanged request",
	notFound:
		"No command result found. This does not prove the command never ran. You may explicitly retry the exact saved request.",
	failed: "Could not verify the result. Your input and original request are preserved.",
	incompatible:
		"An older or invalid recovery record is preserved. It cannot be safely replayed; inspect the existing directory before creating more items.",
	archiveNote:
		"Archive hides this conversation from the active list. It does not delete messages or drafts, cancel tasks, or revoke permissions.",
	restoreNote:
		"Restore returns this conversation to the active list. It does not resume execution or restore expired or revoked permissions.",
	renameNote: "Only the title changes. Messages, drafts, execution and permissions remain unchanged.",
	archivedNote:
		"This conversation is archived. Restore it before submitting new work. Existing work is not automatically resumed.",
	currentFailed: "Could not load the selected item. Your selection and drafts are preserved.",
	searchScope: "Search matches only the currently displayed pages of expanded projects.",
} as const;
const zh: Record<keyof typeof en, string> = {
	first: "第一页",
	next: "下一页",
	active: "当前会话",
	archived: "已归档会话",
	filter: "会话列表",
	loaded: "本页数量",
	rename: "重命名会话",
	archive: "归档会话",
	restore: "恢复会话",
	confirm: "确认",
	close: "关闭",
	title: "标题",
	pending: "目录操作结果尚未确认，原始请求已保留，请勿另建替代请求。",
	check: "核对原请求",
	retry: "重试原始请求",
	notFound: "尚未查到命令结果，不能据此证明操作未发生。可明确选择以同一请求和原始内容重试。",
	failed: "未能核实结果，输入与原始请求均已保留。",
	incompatible: "旧版或无效恢复记录已保留，无法安全重放；请先核对现有目录，不要重复创建。",
	archiveNote: "归档将从当前列表隐藏此会话，不会删除消息或草稿、取消任务或撤销权限。",
	restoreNote: "恢复会话只将其移回当前列表，不会恢复执行或复活过期、已撤销的授权。",
	renameNote: "仅更改标题，消息、草稿、执行与权限不变。",
	archivedNote: "此会话已归档，提交新任务前请先恢复会话。已有任务不会自动恢复执行。",
	currentFailed: "无法读取所选项目，当前选择与草稿已保留。",
	searchScope: "仅搜索已展开项目当前显示的会话页。",
};
export function catalogLabels(locale: string) {
	return locale === "en" ? en : zh;
}
