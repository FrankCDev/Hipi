import { type CodeViewFileItem, DEFAULT_VIRTUAL_FILE_METRICS, parseDiffFromFile } from "@pierre/diffs";
import { Editor, type EditorFactory, type EditorViewState } from "@pierre/diffs/edit";
import { CodeView, type CodeViewHandle, EditProvider, FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { useThemeSettings } from "../../app/theme/index.ts";
import type { CodeEditorProps } from "./code-editor.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS, matchesEditorBinding } from "./editor-keybindings.ts";
import { fileLabels } from "./file-labels.ts";
import { useFileLineNavigation } from "./file-line-navigation.tsx";
import { useFileSearch } from "./file-search.tsx";
import { BoundedTextDocument } from "./pierre-document.ts";
import { fileLanguage, PIERRE_CSS, pierreTheme } from "./pierre-theme.ts";

const createEditor: EditorFactory<undefined, undefined> = (type, options) => new Editor(type, options);
const options = {
	preferredHighlighter: "shiki-js",
	disableFileHeader: true,
	overflow: "scroll",
	unsafeCSS: PIERRE_CSS,
	layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
} as const;
type PierreNavigationSnapshot = {
	editor?: EditorViewState;
	lines: ReturnType<CodeViewHandle<undefined, undefined>["getSelectedLines"]>;
	scrollTop: number;
	scrollLeft: number;
};

/**
 * Local edit notifications never feed controlled items back into Pierre.
 * Only a divergent external replacement starts a fresh renderer generation.
 */
export function PierreCodeEditor(props: CodeEditorProps) {
	const observed = useRef(props.text);
	const epoch = useRef(0);
	const [initial, setInitial] = useState({ text: props.text, readOnly: props.readOnly, epoch: 0 });
	useEffect(() => {
		if (observed.current === props.text && initial.readOnly === props.readOnly) return;
		observed.current = props.text;
		epoch.current++;
		if (props.memory) props.memory.pierre = undefined;
		setInitial({ text: props.text, readOnly: props.readOnly, epoch: epoch.current });
	}, [props.text, props.readOnly, props.memory, initial.readOnly]);
	return (
		<PierreSurface
			key={initial.epoch}
			{...props}
			initialText={initial.text}
			current={() => epoch.current === initial.epoch}
			onChange={(text) => {
				if (epoch.current !== initial.epoch || props.readOnly) return;
				observed.current = text;
				props.onChange(text);
			}}
		/>
	);
}

function PierreSurface({
	text,
	initialText,
	name = "untitled.txt",
	label,
	readOnly,
	memory,
	onChange,
	onSave,
	bindings = DEFAULT_EDITOR_KEYBINDINGS,
	current,
}: CodeEditorProps & { initialText: string; current: () => boolean }) {
	const { locale } = usePreferences();
	const { config } = useThemeSettings();
	const viewOptions = useMemo(
		() => ({
			...options,
			theme: pierreTheme(config.codeTheme),
			themeType: config.mode,
			itemMetrics: { lineHeight: config.codeFontSize * 1.55 },
		}),
		[config.codeFontSize, config.codeTheme, config.mode],
	);
	const l = fileLabels(locale);
	const handle = useRef<CodeViewHandle<undefined, undefined>>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const section = useRef<HTMLElement>(null);
	const navigationRevision = useRef(0);
	const [limit, setLimit] = useState(false);
	const [initialState] = useState(() => {
		const previous = memory?.pierre;
		if (previous?.document.getText() === initialText && previous.document instanceof BoundedTextDocument)
			return previous;
		const document = new BoundedTextDocument(name, initialText, fileLanguage(name));
		return { type: "file" as const, document };
	});
	const [items] = useState<CodeViewFileItem[]>([
		{ id: "document", type: "file", edit: !readOnly, file: { name, contents: initialText, lang: fileLanguage(name) } },
	]);
	const search = useFileSearch({
		document: initialState.document,
		text,
		bindings,
		memory,
		readOnly,
		replace: (changes) => {
			const editor = handle.current?.getEditor("document");
			if (!current() || !editor || readOnly || initialState.document.getText() !== text) return false;
			editor.applyEdits(
				changes.map(({ from, to, text }) => ({
					range: { start: initialState.document.positionAt(from), end: initialState.document.positionAt(to) },
					newText: text,
				})),
			);
			return true;
		},
		select: ([from, to]) => {
			const start = initialState.document.positionAt(from);
			const end = initialState.document.positionAt(to);
			handle.current?.getEditor("document")?.setSelections([{ start, end, direction: "forward" }]);
			handle.current?.scrollTo({ type: "line", id: "document", lineNumber: start.line + 1, align: "center" });
		},
		focus: () => {
			const editor = handle.current?.getEditor("document");
			if (editor) editor.focus({ preventScroll: true });
			else if (current() && readOnly) section.current?.focus({ preventScroll: true });
		},
	});
	const lineNavigation = useFileLineNavigation<PierreNavigationSnapshot>({
		bindings,
		getTarget: () => {
			const controller = handle.current;
			const editor = controller?.getEditor("document");
			const document = initialState.document;
			if (!current() || !controller || (!readOnly && !editor) || document.getText() !== text) return;
			return {
				identity: editor ?? controller,
				document,
				// Pierre restores version numbers on undo; notifications supply the monotonic part.
				generation: `${navigationRevision.current}:${document.version}`,
				capture: () => {
					const state = editor?.getViewState();
					const selection = state?.selections?.[0];
					const lines = controller.getSelectedLines();
					const position = selection
						? selection.direction === -1
							? selection.start
							: selection.end
						: { line: Math.max(0, (lines?.range.start ?? 1) - 1), character: 0 };
					return {
						offset: document.offsetAt(position),
						state: {
							editor: state,
							lines: lines ? { ...lines, range: { ...lines.range } } : null,
							scrollTop: scroll.current?.scrollTop ?? 0,
							scrollLeft: scroll.current?.scrollLeft ?? 0,
						},
					};
				},
				preview: (position) => {
					if (editor) editor.setSelections([{ start: position, end: position, direction: "none" }]);
					else
						controller.setSelectedLines({
							id: "document",
							range: { start: position.line + 1, end: position.line + 1 },
						});
					controller.scrollTo({
						type: "line",
						id: "document",
						lineNumber: position.line + 1,
						align: "center",
						behavior: "instant",
					});
				},
				restore: (snapshot) => {
					if (snapshot.editor && editor) editor.setViewState(snapshot.editor);
					else {
						controller.setSelectedLines(snapshot.lines);
						controller.scrollTo({ type: "position", position: snapshot.scrollTop, behavior: "instant" });
					}
					if (scroll.current) {
						scroll.current.scrollTop = snapshot.scrollTop;
						scroll.current.scrollLeft = snapshot.scrollLeft;
					}
				},
				focus: () => {
					if (editor) editor.focus({ preventScroll: true });
					else section.current?.focus({ preventScroll: true });
				},
			};
		},
	});
	useEffect(() => {
		const document = initialState.document;
		if (document instanceof BoundedTextDocument) document.setLimitListener(setLimit);
		if (scroll.current) scroll.current.scrollTop = memory?.scrollTop ?? 0;
		return () => {
			if (document instanceof BoundedTextDocument) document.setLimitListener(undefined);
		};
	}, [initialState, memory]);
	return (
		<>
			{limit && <p role="alert">{l.inputLimit}</p>}
			{search.panel}
			{lineNavigation.panel}
			<section
				ref={section}
				className="file-code pierre-code"
				aria-label={label}
				data-readonly={readOnly}
				tabIndex={readOnly ? 0 : undefined}
				onKeyDownCapture={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
					if (matchesEditorBinding(event, bindings.save)) {
						event.preventDefault();
						event.stopPropagation();
						onSave?.();
					} else if (!lineNavigation.onKeyDown(event)) search.onKeyDown(event);
				}}
			>
				<EditProvider createEditor={createEditor}>
					<CodeView
						ref={handle}
						className="pierre-editor-viewport"
						containerRef={scroll}
						initialItems={items}
						options={viewOptions}
						disableWorkerPool
						editorOptions={{ initialState, ownsVerticalViewport: true }}
						onScroll={(top) => {
							if (memory && current()) memory.scrollTop = top;
						}}
						onItemEditChange={(event) => {
							if (current()) {
								navigationRevision.current++;
								onChange(event.file.contents);
							}
						}}
						onItemEditComplete={(event) => {
							const state = event.editor.getEditState();
							if (memory && current() && state?.type === "file") memory.pierre = state;
							return "accept";
						}}
					/>
				</EditProvider>
			</section>
		</>
	);
}

export function PierreCodeDiff({
	before,
	after,
	left,
	right,
	name = "untitled.txt",
}: {
	before: string;
	after: string;
	left: string;
	right: string;
	name?: string;
}) {
	const { config } = useThemeSettings();
	const diff = useMemo(
		() =>
			parseDiffFromFile(
				{ name, contents: before, lang: fileLanguage(name) },
				{ name, contents: after, lang: fileLanguage(name) },
			),
		[before, after, name],
	);
	return (
		<section className="file-diff pierre-diff" aria-label={`${left} / ${right}`}>
			<div className="file-diff-labels">
				<span>{left}</span>
				<span>{right}</span>
			</div>
			<Virtualizer className="pierre-diff-viewport">
				<FileDiff
					fileDiff={diff}
					disableWorkerPool
					metrics={{ ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: config.codeFontSize * 1.55 }}
					options={{
						...options,
						theme: pierreTheme(config.codeTheme),
						themeType: config.mode,
						diffStyle: "split",
						expandUnchanged: true,
						hunkSeparators: "line-info-basic",
					}}
				/>
			</Virtualizer>
		</section>
	);
}
