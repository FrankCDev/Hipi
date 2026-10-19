const en = {
	"filePanel.show": "Show files",
	"filePanel.hide": "Hide files",
	"filePanel.title": "Workspace files",
	"filePanel.description":
		"Browse authorized files and edit. Hiding this panel keeps unsaved edits in this window; previews close.",
	"filePanel.resize": "File panel width",
	"filePanel.resizeHint": "Use Left and Right arrows to resize; Home for minimum, End for maximum.",
	"filePanel.storageFailed": "Panel preference could not be saved. It remains active in this window.",
} as const;
const zh: Record<keyof typeof en, string> = {
	"filePanel.show": "显示文件",
	"filePanel.hide": "收起文件",
	"filePanel.title": "工作区文件",
	"filePanel.description": "浏览已授权文件并编辑。收起后未保存的修改仍保留在当前窗口，预览会关闭。",
	"filePanel.resize": "文件面板宽度",
	"filePanel.resizeHint": "使用左右方向键调整宽度；Home 最小，End 最大。",
	"filePanel.storageFailed": "面板偏好未能保存，当前窗口仍可使用。",
};
export function filePanelLabels(locale: string) {
	return locale === "en" ? en : zh;
}
