const en = {
	service: "Uses OpenAI’s official service and built-in models.",
	key: "API key",
	placeholder: "Enter a key; saved keys are never shown",
	system: "Stored securely on this device. Saving does not contact OpenAI.",
	memory: "Stored only until the development host restarts. Saving does not contact OpenAI.",
	noPort: "This connection cannot manage API keys.",
	loading: "Reading key status…",
	configured: "Key configured",
	missing: "No key configured",
	locked: "Secure storage is locked",
	unavailable: "Secure storage is unavailable",
	save: "Save",
	remove: "Remove key",
	refresh: "Refresh status",
	saved: "Key saved.",
	removed: "Key removed.",
	invalid: "Use a key of up to 4,096 printable ASCII characters, without spaces.",
	unknown: "The key change could not be confirmed. Refresh its status before trying again.",
	statusUnknown: "Key status could not be confirmed.",
} as const;

type Labels = { [K in keyof typeof en]: string };
const zh: Labels = {
	service: "使用 OpenAI 官方服务与内置模型。",
	key: "API Key",
	placeholder: "输入密钥，已保存的密钥不会回显",
	system: "密钥安全保存在本机，保存不会请求 OpenAI。",
	memory: "密钥仅保留至开发服务重启，保存不会请求 OpenAI。",
	noPort: "当前连接不提供密钥管理。",
	loading: "正在读取密钥状态…",
	configured: "已配置密钥",
	missing: "尚未配置密钥",
	locked: "安全存储已锁定",
	unavailable: "安全存储不可用",
	save: "保存",
	remove: "移除密钥",
	refresh: "刷新状态",
	saved: "密钥已保存。",
	removed: "密钥已移除。",
	invalid: "密钥只能包含最多 4,096 个可打印 ASCII 字符，不能包含空格。",
	unknown: "无法确认密钥是否已修改，请刷新状态后再操作。",
	statusUnknown: "无法确认密钥状态。",
};

export function legacyProviderLabels(locale: "en" | "zh-CN"): Labels {
	return locale === "en" ? en : zh;
}
