export function projectRecoveryLabels(locale: string) {
	return locale.startsWith("zh")
		? {
				defaultUnverified: "尚无法核实默认聊天位置。已有项目和会话仍可使用，原记录不会被改写。",
				metadataFailed: "暂时无法读取项目。请刷新重试。",
			}
		: {
				defaultUnverified:
					"The default chat destination could not be verified. Existing projects and conversations remain available; original records are preserved.",
				metadataFailed: "Projects could not be loaded. Refresh to try again.",
			};
}
