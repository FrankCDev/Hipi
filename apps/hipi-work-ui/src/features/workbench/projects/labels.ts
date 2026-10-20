const en = {
	rename: "Rename project",
	legacyHistory: "Recent legacy chats",
	name: "Name",
	renameNote: "Only the project name changes. Chats, drafts, execution and folder permissions remain unchanged.",
	pin: "Pin project",
	unpin: "Unpin project",
} as const;
const zh: Record<keyof typeof en, string> = {
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
