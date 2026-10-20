const en = {
	"capabilities.title": "Conversation capabilities",
	"capabilities.trigger": "Capabilities",
	"capabilities.contextAction": "File context",
	"capabilities.contextHint": "Allow this conversation to read selected live files",
	"capabilities.toolsAction": "Tools",
	"capabilities.toolsHint": "Review and authorize tools for this conversation",
	"capabilities.description":
		"Control the files and tools this conversation can use. Review access, approvals, and authorization history in one place.",
	"capabilities.navigation": "Capability sections",
	"capabilities.files": "File access & approvals",
	"capabilities.filesDescription": "Choose file context, review proposed writes, and check unresolved results.",
	"capabilities.tools": "Tool packs",
	"capabilities.toolsDescription": "Review installed versions and explicitly authorize tools for this conversation.",
	"capabilities.scope": "This conversation",
	"capabilities.close": "Close",
};
type Labels = { [K in keyof typeof en]: string };
const zh: Labels = {
	"capabilities.title": "会话能力",
	"capabilities.trigger": "能力",
	"capabilities.contextAction": "文件上下文",
	"capabilities.contextHint": "授权当前会话读取选定的实时文件",
	"capabilities.toolsAction": "工具",
	"capabilities.toolsHint": "查看并授权当前会话使用的工具",
	"capabilities.description": "在同一处管理此会话可使用的文件与工具，查看授权、审批和历史记录。",
	"capabilities.navigation": "能力分类",
	"capabilities.files": "文件访问与审批",
	"capabilities.filesDescription": "选择文件上下文，审阅拟写入内容，并核对结果未明的操作。",
	"capabilities.tools": "工具包",
	"capabilities.toolsDescription": "审阅已安装版本，并明确授权此会话使用工具。",
	"capabilities.scope": "当前会话",
	"capabilities.close": "关闭",
};
export function capabilityLabels(locale: string): Labels {
	return locale.startsWith("zh") ? zh : en;
}
