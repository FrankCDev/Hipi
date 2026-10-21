const english = {
	"host.startup.failed": "Desktop startup failed. No command was replayed.",
	"host.shutdown.unknown":
		"Runtime shutdown is not confirmed. Pending command outcomes remain unknown. Ownership is retained until the runtime exits.",
	"host.unsaved.discard": "Discard and continue",
	"host.unsaved.keep": "Keep working",
	"host.unsaved.message": "Unsaved input may be lost.",
	"host.unsaved.detail": "Continue closing or reloading this window? Accepted work is not cancelled.",
	"host.provider.deterministic": "Hipi Work · Deterministic test provider",
} as const;

type HostMessages = { readonly [Key in keyof typeof english]: string };
const chinese: HostMessages = {
	"host.startup.failed": "桌面应用启动失败。没有重放任何命令。",
	"host.shutdown.unknown": "尚未确认运行时已退出。待处理命令的结果仍未知，运行时退出前会继续保留存储所有权。",
	"host.unsaved.discard": "放弃修改并继续",
	"host.unsaved.keep": "继续编辑",
	"host.unsaved.message": "未保存的输入可能丢失。",
	"host.unsaved.detail": "继续关闭或重新加载此窗口？已接受的任务不会因此取消。",
	"host.provider.deterministic": "Hipi Work · 确定性测试模型",
};

/** Native host dialogs use the OS locale; they remain available when the renderer cannot start. */
export function hostMessages(locale: string): HostMessages {
	return /^zh(?:[-_]|$)/i.test(locale) ? chinese : english;
}
