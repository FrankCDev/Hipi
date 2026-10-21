const en = {
	unavailable: "The rest of this reply could not be loaded.",
	cancel: "Stop loading",
	continue: "Continue reading",
	long: "This reply is long. The first section is shown; more content can be read in pages.",
};
type Labels = { [Key in keyof typeof en]: string };
const zh: Labels = {
	unavailable: "暂时无法加载这条回复的其余内容。",
	cancel: "停止加载",
	continue: "继续阅读",
	long: "这条回复较长，当前显示首段，其余内容可分页阅读。",
};
export function messageContentLabels(locale: string): Labels {
	return locale.startsWith("zh") ? zh : en;
}
