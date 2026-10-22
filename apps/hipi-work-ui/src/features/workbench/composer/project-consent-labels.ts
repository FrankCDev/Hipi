const en = {
	recoveryCreate: "Your message has not been sent. Check the new chat's creation before continuing.",
	recoveryAuthorize: "Your message has not been sent. Check the project-access request before continuing.",
	recoverySubmit: "Message delivery is unconfirmed. Check its status; no new message will be created.",
	recoveryInvalid: "The prepared project access is no longer valid. Your original message is preserved.",
	recoverDraft: "Continue in the created chat without sending",
	recoverSource: "Keep the original message as a draft",
	combine: "Combine both texts into a draft",
	combineDescription:
		"A newer draft is already present. Combining keeps that draft first, then appends your original unsent text after a separator. Nothing is sent.",
	combineFailed:
		"If the draft changed or the combined text is too long, both originals stay unchanged. Review the current draft before trying again.",
	grantRemains:
		"Project access already confirmed for this chat remains active. You can review or revoke it in the chat.",
} as const;
const zh: Record<keyof typeof en, string> = {
	recoveryCreate: "消息尚未发送。请先核对新聊天的创建结果。",
	recoveryAuthorize: "消息尚未发送。请先核对项目访问授权结果。",
	recoverySubmit: "尚未确认消息送达。请核对状态，不会另建一条消息。",
	recoveryInvalid: "准备的项目访问权限已失效，原始消息已保留。",
	recoverDraft: "在已创建的聊天中继续，不发送消息",
	recoverSource: "将原始消息保留为草稿",
	combine: "将两段内容合并为草稿",
	combineDescription: "已有较新的草稿。合并时先保留现有草稿，再以分隔线追加原始未发送内容，不会发送任何消息。",
	combineFailed: "如果草稿已变化或合并后超出长度限制，两段原文均保持不变。请检查现有草稿后再试。",
	grantRemains: "此聊天此前确认的项目访问仍有效，可在聊天中查看或撤销。",
};
export function preparedProjectConsentLabels(locale: string) {
	return locale === "en" ? en : zh;
}
