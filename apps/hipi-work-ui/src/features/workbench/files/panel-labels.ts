const en = {
	"filePanel.show": "Show files",
	"filePanel.hide": "Hide files",
	"filePanel.title": "Workspace files",
	"filePanel.description":
		"Browse authorized files and edit. Hiding this panel keeps unsaved edits in this window. Previews reload when reopened.",
	"filePanel.resize": "File panel width",
	"filePanel.resizeHint":
		"Left and Right resize; Home sets minimum, End sets normal maximum. At minimum, Right hides files. At maximum, Left fills the workspace; Right restores the split.",
	"filePanel.storageFailed": "Panel preference could not be saved. It remains active in this window.",
} as const;
const zh: Record<keyof typeof en, string> = {
	"filePanel.show": "显示文件",
	"filePanel.hide": "收起文件",
	"filePanel.title": "工作区文件",
	"filePanel.description": "浏览已授权文件并编辑。收起后未保存的修改仍保留在当前窗口，重新打开时会重新加载预览。",
	"filePanel.resize": "文件面板宽度",
	"filePanel.resizeHint":
		"左右方向键调整宽度；Home 最小，End 常规最大。最小时按右键收起文件，最大时按左键铺满工作区；铺满后按右键恢复分栏。",
	"filePanel.storageFailed": "面板偏好未能保存，当前窗口仍可使用。",
};
export function filePanelLabels(locale: string) {
	return locale === "en" ? en : zh;
}
