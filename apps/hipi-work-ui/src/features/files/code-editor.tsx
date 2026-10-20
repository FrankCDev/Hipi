import type { FileEditorKeybindings } from "./editor-keybindings.ts";
import type { EditorViewMemory } from "./editor-view-memory.ts";
import { MarkdownEditor } from "./markdown-editor.tsx";
import { PierreCodeEditor } from "./pierre-editor.tsx";

export type CodeEditorProps = {
	text: string;
	name?: string;
	onChange: (value: string) => void;
	label: string;
	readOnly: boolean;
	memory?: EditorViewMemory;
	onSave?: () => void;
	focusRequest?: number;
	onFocusHandled?: (request: number) => void;
	bindings?: FileEditorKeybindings;
};

/** Text ownership is independent of the ordinary-code and Markdown rendering engines. */
export function CodeEditor(props: CodeEditorProps) {
	return /\.(?:md|mdx|markdown)$/i.test(props.name ?? "") ? (
		<MarkdownEditor {...props} />
	) : (
		<PierreCodeEditor {...props} />
	);
}
export { PierreCodeDiff as CodeDiff } from "./pierre-editor.tsx";
