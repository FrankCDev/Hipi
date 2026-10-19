import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { boundedEditorInput, inputLimitExceeded } from "./editor-limits.ts";
import { fileLabels } from "./file-labels.ts";

const theme = EditorView.theme({
	"&": { height: "100%", color: "var(--text)", backgroundColor: "var(--surface)", fontSize: "inherit" },
	".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
	".cm-gutters": { backgroundColor: "var(--canvas)", color: "var(--muted)", borderColor: "var(--line)" },
	".cm-content": { caretColor: "var(--text)" },
	"&.cm-focused": { outline: "2px solid var(--focus)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--brand-soft)" },
});
export function CodeEditor({
	text,
	onChange,
	label,
	readOnly,
}: {
	text: string;
	onChange: (value: string) => void;
	label: string;
	readOnly: boolean;
}) {
	const { locale } = usePreferences();
	const [limitExceeded, setLimitExceeded] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const config = useRef(new Compartment());
	const initial = useRef(text);
	const change = useRef(onChange);
	change.current = onChange;
	useEffect(() => {
		if (!host.current) return;
		const editor = new EditorView({
			parent: host.current,
			doc: initial.current,
			extensions: [
				theme,
				boundedEditorInput,
				lineNumbers(),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				config.current.of([]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) change.current(update.state.doc.toString());
					setLimitExceeded(update.state.field(inputLimitExceeded));
				}),
			],
		});
		view.current = editor;
		return () => {
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
		if (editor && editor.state.doc.toString() !== text)
			editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
	}, [text]);
	return (
		<>
			{limitExceeded && <p role="alert">{fileLabels(locale).inputLimit}</p>}
			<div ref={host} className="file-code" />
		</>
	);
}
export function CodeDiff({
	before,
	after,
	left,
	right,
}: {
	before: string;
	after: string;
	left: string;
	right: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!host.current) return;
		const view = new MergeView({
			parent: host.current,
			a: {
				doc: before,
				extensions: [
					theme,
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ "aria-label": left }),
				],
			},
			b: {
				doc: after,
				extensions: [
					theme,
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ "aria-label": right }),
				],
			},
			highlightChanges: true,
			gutter: true,
		});
		return () => view.destroy();
	}, [before, after, left, right]);
	return <div ref={host} className="file-diff" />;
}
