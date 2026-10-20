const en = {
	"workbench.modelStatus": "Model status",
	"workbench.runtimeControls": "Runtime controls",
	"workbench.hideNavigation": "Hide navigation",
	"workbench.welcomeEyebrow": "A little clarity. A lot of possibility.",
	"workbench.welcomeBody":
		"Give related work a shared home. Start a conversation, bring the right context, and build toward a clear result.",
	"workbench.workspaceBody": "Your workspace is ready. Start a conversation to turn a goal into a clear next step.",
	"workbench.goalTitle": "Start with a goal",
	"workbench.goalBody": "Say what you want to achieve and what a useful result looks like.",
	"workbench.contextTitle": "Choose the context",
	"workbench.contextBody": "Decide which files your agent can access and review requested changes.",
	"workbench.resultTitle": "Keep the thread",
	"workbench.resultBody": "Return to saved conversations, inspect results, and continue the work.",
	"workbench.starters": "Start with an editable prompt",
	"workbench.starterHint": "Choose a starting point, then make it yours.",
	"workbench.starter.plan": "Make a plan",
	"workbench.starter.planPrompt":
		"Help me turn this goal into a practical plan. Ask me about the outcome, constraints, and deadline first: ",
	"workbench.starter.write": "Shape an idea",
	"workbench.starter.writePrompt":
		"Help me organize these ideas into a clear draft. First, ask who it is for and what it should achieve: ",
	"workbench.starter.solve": "Work through a problem",
	"workbench.starter.solvePrompt":
		"Help me investigate this problem. Separate what we know from assumptions and suggest the next checks: ",
} as const;
const zh: Record<keyof typeof en, string> = {
	"workbench.modelStatus": "模型状态",
	"workbench.runtimeControls": "运行时管理",
	"workbench.hideNavigation": "收起导航",
	"workbench.welcomeEyebrow": "把想法，变成下一步。",
	"workbench.welcomeBody": "为相关工作创建一个空间。开始会话、提供合适的上下文，一起把目标变成清晰的成果。",
	"workbench.workspaceBody": "工作区已就绪。开始一段会话，把目标变成清晰的下一步。",
	"workbench.goalTitle": "从目标开始",
	"workbench.goalBody": "说明想完成什么，以及怎样的结果才算有用。",
	"workbench.contextTitle": "选择工作上下文",
	"workbench.contextBody": "决定 Agent 可以访问哪些文件，并审阅请求的修改。",
	"workbench.resultTitle": "让工作持续推进",
	"workbench.resultBody": "回到已保存的会话，查看结果，继续未完的工作。",
	"workbench.starters": "选择可编辑的起始提示",
	"workbench.starterHint": "选一个起点，再补充你的具体目标。",
	"workbench.starter.plan": "制定一个计划",
	"workbench.starter.planPrompt": "帮我把这个目标整理成可执行的计划。先询问预期结果、限制条件和截止时间：",
	"workbench.starter.write": "梳理一个想法",
	"workbench.starter.writePrompt": "帮我把这些想法整理成清晰的初稿。先询问内容面向谁，以及希望达成什么目的：",
	"workbench.starter.solve": "一起解决问题",
	"workbench.starter.solvePrompt": "帮我分析这个问题。区分已知事实与假设，并建议下一步应该核查什么：",
};
export function workbenchLabels(locale: string) {
	return locale === "en" ? en : zh;
}
