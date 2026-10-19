const english = {
	"diagnostics.menu": "Export desktop diagnostics…",
	"diagnostics.help": "Help",
	"diagnostics.title": "Desktop diagnostics",
	"diagnostics.preview": "Review the complete diagnostic file below before saving.",
	"diagnostics.scope":
		"Only app/runtime versions, platform, architecture, runtime state and bounded session-local event counts are included. No work content, credentials, paths or raw logs are collected. Nothing is uploaded. Choose a new filename; existing files are not overwritten.",
	"diagnostics.save": "Choose save location…",
	"diagnostics.cancel": "Cancel",
	"diagnostics.busy":
		"An export is still active. If a write timed out, wait for the file operation to settle before starting another export.",
	"diagnostics.saved": "Desktop diagnostics saved. You can review the file before sharing it yourself.",
	"diagnostics.failed": "Diagnostics could not be prepared. No file write was attempted.",
	"diagnostics.unknown":
		"The file write was not confirmed. Check the selected location for an existing or partial file before trying again. No automatic retry was made.",
} as const;
type Messages = { readonly [Key in keyof typeof english]: string };
const chinese: Messages = {
	"diagnostics.menu": "导出桌面诊断…",
	"diagnostics.help": "帮助",
	"diagnostics.title": "桌面诊断",
	"diagnostics.preview": "保存前请检查下方显示的完整诊断内容。",
	"diagnostics.scope":
		"仅包含应用与运行时版本、平台、架构、运行时状态和本次桌面进程内有上限的事件计数。不采集工作内容、凭据、路径或原始日志，不上传任何内容。请选择新文件名，不会覆盖已有文件。",
	"diagnostics.save": "选择保存位置…",
	"diagnostics.cancel": "取消",
	"diagnostics.busy": "已有诊断导出正在进行。如果写入等待超时，需要等文件操作结束后才能再次导出。",
	"diagnostics.saved": "桌面诊断已保存。可先检查文件，再自行决定是否分享。",
	"diagnostics.failed": "无法准备诊断文件，尚未尝试写入文件。",
	"diagnostics.unknown": "尚未确认文件写入成功。再次尝试前，请检查所选位置是否已有文件或部分内容。没有自动重试。",
};
export function diagnosticMessages(locale: string): Messages {
	return /^zh(?:[-_]|$)/i.test(locale) ? chinese : english;
}
