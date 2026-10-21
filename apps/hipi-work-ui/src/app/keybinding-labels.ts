import type { AppKeybindings } from "./keybindings.ts";

const en: Record<keyof AppKeybindings, string> = {
	reopenClosedFile: "Reopen closed file",
	pinConversation: "Pin conversation",
	searchConversations: "Search conversations",
	moveSidebarUp: "Move sidebar item up",
	moveSidebarDown: "Move sidebar item down",
	cancelSidebarMove: "Cancel sidebar move",
	previousSidebarItem: "Previous sidebar item",
	previousSidebarItemAlternate: "Previous sidebar item (alternate)",
	nextSidebarItem: "Next sidebar item",
	nextSidebarItemAlternate: "Next sidebar item (alternate)",
};
const zh: typeof en = {
	reopenClosedFile: "重新打开已关闭的文件",
	pinConversation: "置顶会话",
	searchConversations: "搜索会话",
	moveSidebarUp: "向上移动侧栏项目",
	moveSidebarDown: "向下移动侧栏项目",
	cancelSidebarMove: "取消侧栏移动",
	previousSidebarItem: "上一个侧栏项目",
	previousSidebarItemAlternate: "上一个侧栏项目（备用快捷键）",
	nextSidebarItem: "下一个侧栏项目",
	nextSidebarItemAlternate: "下一个侧栏项目（备用快捷键）",
};

/** Command labels for configuration consumers; no keyboard settings UI is implied. */
export function appKeybindingLabels(locale: "zh-CN" | "en") {
	return locale === "en" ? en : zh;
}
