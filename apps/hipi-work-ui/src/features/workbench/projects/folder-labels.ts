const en = {
	title: "Project folder",
	choose: "Choose folder",
	change: "Choose another folder",
	unbind: "Disconnect folder",
	reconnect: "Reconnect folder",
	unbound: "No local folder connected",
	available: "Connected for local browsing",
	unavailable: "Folder is unavailable",
	moved: "Folder has moved or changed",
	revoked: "Folder access was revoked",
	description:
		"Connect a folder on this computer to this project. Hipi remembers it and opens it read-only in Project files. New chats in this project can read the folder by default; write access is not granted.",
	disclosure:
		"New project chats need no separate project-file authorization. External folders need explicit access, and every Agent write still needs approval.",
	recovery:
		"Select the folder again to restore local browsing. Old model permissions and write approvals are not restored.",
	recoverFromMenu: "Open Project folder in the project's menu to reconnect it.",
	writeAccess:
		"To edit files, explicitly authorize a read-and-write folder in Project files → Folder access. For Agent edits, select that read-and-write entry in this chat's context permissions. Each write still needs approval.",
	creation:
		"A folder is optional. Connecting it enables local browsing and default read access for new chats in this project, not file changes.",
	chooseOptional: "Choose a project folder (optional)",
	removeSelection: "Remove folder selection",
	createFolderFailed: "Project created, but the folder connection could not be confirmed. Check its current state.",
	folderPickFailed: "Could not select a folder. Your project draft has been kept.",
	loading: "Checking project folder…",
	failed: "Could not confirm the folder change. Check its current state before trying again.",
	check: "Check folder",
	close: "Close",
	cancel: "Cancel",
	unsupported: "Local folder binding is available in the desktop app. You can still use this project for chats.",
	dirtyTitle: "Keep unsaved file changes?",
	dirtyDescription:
		"Changing this folder disconnects its open files. Keep editing, or discard the listed changes and continue. Choosing Cancel in the folder picker keeps the current folder and files.",
	keep: "Keep editing",
	discard: "Discard changes and continue",
	changed: "A file changed while this action was open. Review its latest changes before continuing.",
	readonly: "Read-only · On this computer",
} as const;
const zh: Record<keyof typeof en, string> = {
	title: "项目文件夹",
	choose: "选择文件夹",
	change: "选择其他文件夹",
	unbind: "断开文件夹",
	reconnect: "重新连接文件夹",
	unbound: "尚未连接本机文件夹",
	available: "已连接，可在本机浏览",
	unavailable: "文件夹暂不可用",
	moved: "文件夹已移动或发生变化",
	revoked: "文件夹访问已撤销",
	description:
		"将此电脑上的文件夹连接到项目。Hipi 会记住它，并在「项目文件」中以只读方式打开。此项目中新建的聊天默认可读取该文件夹，不会获得写入权限。",
	disclosure: "新建项目聊天无需另行授权项目文件访问。外部文件夹仍需明确授权，Agent 的每次写入仍需审批。",
	recovery: "请重新选择文件夹以恢复本机浏览。旧模型权限与写入审批不会恢复。",
	recoverFromMenu: "请在项目菜单中打开「项目文件夹」并重新连接。",
	writeAccess:
		"需要编辑文件时，请在「项目文件 → 目录访问」中明确授权可读写目录。需要 Agent 编辑时，再于此聊天的上下文权限中选择该可读写条目；每次写入仍需审批。",
	creation: "文件夹为可选项。连接后可在本机浏览，此项目中新建的聊天默认可读取文件，不会获得文件修改权限。",
	chooseOptional: "选择项目文件夹（可选）",
	removeSelection: "移除文件夹选择",
	createFolderFailed: "项目已创建，但未能确认文件夹连接。请核对当前状态。",
	folderPickFailed: "未能选择文件夹，已保留项目草稿。",
	loading: "正在检查项目文件夹…",
	failed: "未能确认文件夹变更。请先核对当前状态，再尝试操作。",
	check: "检查文件夹",
	close: "关闭",
	cancel: "取消",
	unsupported: "本机文件夹绑定需要桌面应用。此项目仍可用于聊天。",
	dirtyTitle: "保留未保存的文件修改？",
	dirtyDescription:
		"更换文件夹将断开其已打开的文件。可以继续编辑，或放弃下列修改后继续。在文件选择器中取消，会保留当前文件夹和文件。",
	keep: "继续编辑",
	discard: "放弃修改并继续",
	changed: "操作期间文件发生了变化。请查看最新修改后再继续。",
	readonly: "只读 · 此电脑",
};
export function projectFolderLabels(locale: string) {
	return locale === "en" ? en : zh;
}
