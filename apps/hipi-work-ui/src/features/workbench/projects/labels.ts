const en = {
	nameTooLong: "Use no more than 128 characters.",
	rename_unconfirmed: "The project rename is unconfirmed or failed. The pin change was not applied.",
	pin_not_applied: "The pin change was not applied. Project details may have changed; try again.",
	rename: "Rename project",
	legacyHistory: "Recent legacy chats",
	name: "Name",
	renameNote: "Only the project name changes. Chats, drafts, execution and folder permissions remain unchanged.",
	pin: "Pin project",
	unpin: "Unpin project",
} as const;
const zh: Record<keyof typeof en, string> = {
	nameTooLong: "名称不能超过 128 个字符。",
	rename_unconfirmed: "项目重命名尚未确认或已失败，未应用置顶更改。",
	pin_not_applied: "未应用置顶更改。项目信息可能已变化，请重试。",
	rename: "重命名项目",
	legacyHistory: "最近的旧版聊天",
	name: "名称",
	renameNote: "仅更改项目名称，聊天、草稿、执行与文件夹权限不变。",
	pin: "置顶项目",
	unpin: "取消置顶项目",
};
export function projectLabels(locale: string) {
	return locale === "en" ? en : zh;
}
