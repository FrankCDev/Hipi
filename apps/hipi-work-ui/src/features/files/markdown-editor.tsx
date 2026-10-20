import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, type EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { TextDocument } from "@pierre/diffs/edit";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS, type FileEditorKeybindings } from "./editor-keybindings.ts";
import { boundedEditorInput, inputLimitExceeded } from "./editor-limits.ts";
import type { EditorViewMemory } from "./editor-view-memory.ts";
import { fileLabels } from "./file-labels.ts";
import { useFileLineNavigation } from "./file-line-navigation.tsx";
import { useFileSearch } from "./file-search.tsx";
import {
	externalMarkdownText,
	markdownFileText,
	markdownLineEndings,
	replaceMarkdownText,
} from "./markdown-line-endings.ts";
import { markdownPresentation } from "./markdown-presentation.ts";

const theme = EditorView.theme({
	"&": { height: "100%", color: "var(--text)", backgroundColor: "var(--surface)", fontSize: "inherit" },
	".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "0" },
	".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 8px", minWidth: "40px" },
	".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
	"&.cm-focused": { outline: "2px solid var(--focus)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--brand-soft)" },
});
type MarkdownPosition = {
	selection: EditorSelection;
	scroll: ReturnType<EditorView["scrollSnapshot"]>;
	top: number;
	left: number;
};
export function MarkdownEditor({
	text,
	onChange,
	label,
	readOnly,
	memory,
	onSave,
	bindings = DEFAULT_EDITOR_KEYBINDINGS,
}: {
	text: string;
	onChange: (value: string) => void;
	label: string;
	readOnly: boolean;
	memory?: EditorViewMemory;
	onSave?: () => void;
	bindings?: FileEditorKeybindings;
}) {
	const { locale } = usePreferences();
	const [limitExceeded, setLimitExceeded] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const config = useRef(new Compartment());
	const initial = useRef(text);
	const change = useRef(onChange);
	const save = useRef(onSave);
	const shortcuts = useRef(bindings);
	const retained = useRef(memory);
	change.current = onChange;
	save.current = onSave;
	const normalizedText = useMemo(() => EditorState.create({ doc: text }).doc.toString(), [text]);
	const searchDocument = useMemo(() => new TextDocument("markdown-search", normalizedText, "text"), [normalizedText]);
	const lineNavigation = useFileLineNavigation<MarkdownPosition>({
		bindings,
		getTarget: () => {
			const editor = view.current;
			if (!editor || markdownFileText(editor.state) !== text) return;
			return {
				identity: editor,
				document: searchDocument,
				generation: editor.state.doc,
				capture: () => ({
					offset: editor.state.selection.main.head,
					state: {
						selection: editor.state.selection,
						scroll: editor.scrollSnapshot(),
						top: editor.scrollDOM.scrollTop,
						left: editor.scrollDOM.scrollLeft,
					},
				}),
				preview: (position) => {
					const offset = searchDocument.offsetAt(position);
					editor.dispatch({
						selection: { anchor: offset },
						effects: EditorView.scrollIntoView(offset, { y: "center" }),
					});
				},
				restore: ({ selection, scroll, top, left }) => {
					editor.dispatch({ selection, effects: scroll });
					editor.scrollDOM.scrollTop = top;
					editor.scrollDOM.scrollLeft = left;
				},
				focus: () => editor.contentDOM.focus({ preventScroll: true }),
			};
		},
	});
	const search = useFileSearch({
		document: searchDocument,
		text: normalizedText,
		bindings,
		memory,
		readOnly,
		replace: (changes) => {
			const editor = view.current;
			if (!editor || editor.state.readOnly || markdownFileText(editor.state) !== text) return false;
			editor.dispatch({ changes: changes.map(({ from, to, text }) => ({ from, to, insert: text })) });
			return true;
		},
		select: ([from, to]) => view.current?.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true }),
		focus: () => view.current?.focus(),
	});
	const openSearch = useRef(search.open);
	openSearch.current = search.open;
	useEffect(() => {
		if (!host.current) return;
		const extensions = [
			theme,
			boundedEditorInput,
			markdownLineEndings(initial.current),
			markdownPresentation,
			lineNumbers(),
			history(),
			keymap.of([
				{
					key: shortcuts.current.save,
					run: () => {
						save.current?.();
						return true;
					},
				},
				{
					key: shortcuts.current.find,
					run: () => {
						openSearch.current();
						return true;
					},
				},
				...defaultKeymap,
				...historyKeymap,
			]),
			config.current.of([]),
			EditorView.updateListener.of((update) => {
				if (
					update.transactions.some(
						(transaction) => transaction.docChanged && !transaction.annotation(externalMarkdownText),
					)
				)
					change.current(markdownFileText(update.state));
				setLimitExceeded(update.state.field(inputLimitExceeded));
			}),
		];
		const previous = retained.current?.state;
		const editor = new EditorView({
			parent: host.current,
			state:
				previous && markdownFileText(previous) === initial.current
					? previous.update({ effects: StateEffect.reconfigure.of(extensions) }).state
					: EditorState.create({ doc: initial.current, extensions }),
		});
		view.current = editor;
		editor.scrollDOM.scrollTop = retained.current?.scrollTop ?? 0;
		editor.scrollDOM.scrollLeft = retained.current?.scrollLeft ?? 0;
		return () => {
			if (retained.current) {
				retained.current.state = editor.state;
				retained.current.scrollTop = editor.scrollDOM.scrollTop;
				retained.current.scrollLeft = editor.scrollDOM.scrollLeft;
			}
			view.current = null;
			editor.destroy();
		};
	}, []);
	useEffect(() => {
		view.current?.dispatch({
			effects: config.current.reconfigure([
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
				EditorView.contentAttributes.of({ "aria-label": label }),
			]),
		});
	}, [readOnly, label]);
	useEffect(() => {
		const editor = view.current;
		if (editor && markdownFileText(editor.state) !== text) editor.dispatch(replaceMarkdownText(editor.state, text));
	}, [text]);
	return (
		<>
			{limitExceeded && <p role="alert">{fileLabels(locale).inputLimit}</p>}
			{search.panel}
			{lineNavigation.panel}
			<section
				className="file-code"
				aria-label={label}
				onKeyDownCapture={(event) => {
					if (!lineNavigation.onKeyDown(event)) search.onKeyDown(event);
				}}
			>
				<div ref={host} className="file-markdown-host" />
			</section>
		</>
	);
}
