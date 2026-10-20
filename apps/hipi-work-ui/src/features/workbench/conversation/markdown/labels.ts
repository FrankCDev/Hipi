const en = {
	"markdown.code": "Code",
	"markdown.table": "Table",
	"markdown.copyCode": "Copy code",
	"markdown.copying": "Copying…",
	"markdown.copyAfterStreaming": "Copy when this code block is complete",
};
type Labels = { [Key in keyof typeof en]: string };
const zh: Labels = {
	"markdown.code": "代码",
	"markdown.table": "表格",
	"markdown.copyCode": "复制代码",
	"markdown.copying": "正在复制…",
	"markdown.copyAfterStreaming": "代码块完成后可复制",
};

export function markdownLabels(locale: string): Labels {
	return locale.startsWith("zh") ? zh : en;
}
