const en = {
	"preview.open": "Preview",
	"preview.close": "Close preview",
	"preview.loading": "Reading preview…",
	"preview.failed":
		"Preview unavailable. The file may be unsupported, unsafe, changed, or no longer authorized. Reopen to retry.",
	"preview.limit": "This file exceeds the preview size, page, or resource limit.",
	"preview.retry": "Reopen preview",
	"preview.previous": "Previous page",
	"preview.next": "Next page",
	"preview.page": "Page",
	"preview.zoom": "Zoom",
	"preview.image": "Authorized image preview",
	"preview.pdf": "PDF page",
	"preview.document": "Plain-text Word preview. Layout, images, links, and embedded content are omitted.",
	"preview.grid":
		"Read-only cell text and saved values. Formulas are not recalculated; formatting, charts, links, and macros are not rendered.",
	"preview.pdfNote":
		"Canvas-only PDF preview, up to 200 pages. Uses bundled CMaps and standard fonts; font substitution and colors may differ. Forms, annotations, scripts, attachments and remote resources are disabled.",
	"preview.partial": "Limited preview: some content is omitted by resource limits.",
	"preview.empty": "This preview page has no displayable content.",
	"preview.sheet": "Sheet",
} as const;
const zh: Record<keyof typeof en, string> = {
	"preview.open": "预览",
	"preview.close": "关闭预览",
	"preview.loading": "正在读取预览…",
	"preview.failed": "无法预览。文件可能不受支持、不安全、已变更或授权已失效。请重新打开以重试。",
	"preview.limit": "文件超过预览大小、页数或资源限制。",
	"preview.retry": "重新打开预览",
	"preview.previous": "上一页",
	"preview.next": "下一页",
	"preview.page": "页",
	"preview.zoom": "缩放",
	"preview.image": "已授权图片预览",
	"preview.pdf": "PDF 页面",
	"preview.document": "Word 纯文本预览。省略排版、图片、链接及嵌入内容，非保真展示。",
	"preview.grid": "只读单元格文本与已保存值。不会重新计算公式；不显示格式、图表、链接或宏。",
	"preview.pdfNote":
		"仅画布 PDF 预览，最多 200 页。使用随应用打包的 CMap 和标准字体；替代字体与颜色可能不同。禁用表单、批注、脚本、附件及远程资源。",
	"preview.partial": "受限预览：部分内容因资源限制而省略。",
	"preview.empty": "此预览页没有可显示内容。",
	"preview.sheet": "工作表",
};
export function previewLabels(locale: string) {
	return locale === "en" ? en : zh;
}
