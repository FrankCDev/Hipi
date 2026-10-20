const en = {
	control: "Permissions",
	staged: "Project files · On Send",
	title: "Project access for your new chat",
	description:
		"Choose what this new chat may share with the selected model. These permissions take effect only when you Send; this dialog creates no chat and sends no files.",
	scope: "Only the new chat created by this Send",
	confirm: "Use these permissions on Send",
	off: "Do not share project files",
	cancel: "Cancel",
	changed: "Project access changed or expired. Your message is kept; review permissions before sending.",
	unavailable: "Connect an available project folder before choosing file permissions.",
	onSend: "Project access is prepared for this Send, not yet granted.",
	recoveryCreate: "Your message has not been sent. Check the new chat's creation before continuing.",
	recoveryAuthorize: "Your message has not been sent. Check the project-access request before continuing.",
	recoverySubmit: "Message delivery is unconfirmed. Check its status; no new message will be created.",
	recoveryInvalid: "The prepared project access is no longer valid. Your original message is preserved.",
	recoverDraft: "Continue in the created chat without sending",
	recoverSource: "Keep message and review permissions",
	combine: "Combine both texts into a draft",
	combineDescription:
		"A newer draft is already present. Combining keeps that draft first, then appends your original unsent text after a separator. Nothing is sent.",
	combineFailed:
		"If the draft changed or the combined text is too long, both originals stay unchanged. Review the current draft before trying again.",
	grantRemains:
		"Project access already confirmed for this chat remains active. You can review or revoke it in the chat.",
} as const;
const zh: Record<keyof typeof en, string> = {
	control: "权限",
	staged: "项目文件 · 发送时生效",
	title: "新聊天的项目访问权限",
	description: "选择新聊天可以向所选模型共享的内容。仅在点击发送后授权；此处不会创建聊天或发送文件。",
	scope: "仅限此次发送创建的新聊天",
	confirm: "发送时使用这些权限",
	off: "不共享项目文件",
	cancel: "取消",
	changed: "项目访问已变化或过期。消息已保留，请在发送前重新检查权限。",
	unavailable: "请先连接可用的项目文件夹，再选择文件权限。",
	onSend: "已为此次发送准备项目访问权限，尚未授予访问。",
	recoveryCreate: "消息尚未发送。请先核对新聊天的创建结果。",
	recoveryAuthorize: "消息尚未发送。请先核对项目访问授权结果。",
	recoverySubmit: "尚未确认消息送达。请核对状态，不会另建一条消息。",
	recoveryInvalid: "准备的项目访问权限已失效，原始消息已保留。",
	recoverDraft: "在已创建的聊天中继续，不发送消息",
	recoverSource: "保留消息，重新检查权限",
	combine: "将两段内容合并为草稿",
	combineDescription: "已有较新的草稿。合并时先保留现有草稿，再以分隔线追加原始未发送内容，不会发送任何消息。",
	combineFailed: "如果草稿已变化或合并后超出长度限制，两段原文均保持不变。请检查现有草稿后再试。",
	grantRemains: "此聊天此前确认的项目访问仍有效，可在聊天中查看或撤销。",
};
export function preparedProjectConsentLabels(locale: string) {
	return locale === "en" ? en : zh;
}
