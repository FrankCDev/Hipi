const en = {
	"inline.details": "Tool call details",
	"inline.close": "Close tool call details",
	"inline.description": "Recorded execution and retained output for this tool call.",
	"inline.plaintext": "plaintext",
	"inline.worked": "Worked",
} as const;
const zh: Record<keyof typeof en, string> = {
	"inline.details": "工具调用详情",
	"inline.close": "关闭工具调用详情",
	"inline.description": "此工具调用的执行记录与已保留输出。",
	"inline.plaintext": "纯文本",
	"inline.worked": "已完成",
};
export function inlineActivityLabels(locale: string) {
	return locale === "en" ? en : zh;
}
