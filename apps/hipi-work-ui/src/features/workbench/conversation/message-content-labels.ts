const en = {
	limit: "This message exceeds the supported text capacity. The visible content is incomplete.",
	unavailable: "The rest of this message could not be loaded.",
	loading: "Loading the complete message…",
	capacity:
		"The rest of this message is not loaded because the text memory budget is currently full. Loading resumes when capacity is available.",
};
type Labels = { [Key in keyof typeof en]: string };
const zh: Labels = {
	limit: "这条消息超过当前支持的文本容量，当前显示的内容并不完整。",
	unavailable: "暂时无法加载这条消息的其余内容。",
	loading: "正在加载完整消息…",
	capacity: "当前文本内存容量已满，这条消息的其余内容尚未加载。容量可用后会自动继续加载。",
};
export function messageContentLabels(locale: string): Labels {
	return locale.startsWith("zh") ? zh : en;
}
