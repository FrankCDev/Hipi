const labels = {
	"response.generating": ["正在生成", "Generating"],
	"response.tools": ["正在处理工具请求", "Processing tool requests"],
	"response.retry": ["等待重试", "Waiting to retry"],
	"response.deferred": ["等待服务响应", "Waiting for the service"],
	"response.compacting": ["正在整理上下文", "Compacting context"],
} as const;

export function responseLabel(key: keyof typeof labels, locale: string) {
	return labels[key][locale === "en" ? 1 : 0];
}
