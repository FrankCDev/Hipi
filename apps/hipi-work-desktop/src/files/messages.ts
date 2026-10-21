const messages = {
	en: {
		"files.picker.read.title": "Allow Hipi Work to read this folder",
		"files.picker.write.title": "Allow Hipi Work to read and edit this folder",
		"files.picker.read.confirm": "Allow read only",
		"files.picker.write.confirm": "Allow read and edit",
		"files.project.title": "Choose project folder",
		"files.project.confirm": "Select",
	},
	zh: {
		"files.picker.read.title": "允许 Hipi Work 读取此文件夹",
		"files.picker.write.title": "允许 Hipi Work 读取和编辑此文件夹",
		"files.picker.read.confirm": "允许只读访问",
		"files.picker.write.confirm": "允许读取和编辑",
		"files.project.title": "选择项目文件夹",
		"files.project.confirm": "选择",
	},
};
export function filePickerLabels(locale: string, writable: boolean) {
	const text = locale.toLowerCase().startsWith("zh") ? messages.zh : messages.en;
	return {
		title: text[writable ? "files.picker.write.title" : "files.picker.read.title"],
		buttonLabel: text[writable ? "files.picker.write.confirm" : "files.picker.read.confirm"],
	};
}
export function chooseProjectDirectory(locale: "en" | "zh-CN") {
	const text = locale === "zh-CN" ? messages.zh : messages.en;
	return { title: text["files.project.title"], buttonLabel: text["files.project.confirm"] };
}
