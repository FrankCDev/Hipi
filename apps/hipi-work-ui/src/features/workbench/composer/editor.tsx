import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { composerDocument, composerDocumentText, composerSchema } from "./editor-document.ts";
import { ComposerKeyboard } from "./keyboard.ts";
import "prosemirror-view/style/prosemirror.css";
import "./editor.css";

export type ComposerEditorHandle = { focus: (options?: FocusOptions) => void };
type Props = {
	ref?: Ref<ComposerEditorHandle>;
	id: string;
	value: string;
	onChange: (text: string) => void;
	onSubmit: () => void;
	onComposingChange?: (composing: boolean) => void;
	readOnly?: boolean;
	maxLength: number;
	placeholder: string;
	label: string;
	describedBy?: string;
};

/** One editor owns selection/history per mounted draft. External resets never enter another draft's undo stack. */
export function ComposerEditor(props: Props) {
	const host = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | null>(null);
	const latest = useRef(props);
	latest.current = props;
	useImperativeHandle(
		props.ref,
		() => ({
			focus: (options) => {
				editor.current?.focus();
				editor.current?.dom.focus(options);
			},
		}),
		[],
	);
	useLayoutEffect(() => {
		if (!host.current) return;
		const keyboard = new ComposerKeyboard();
		const plugins = [
			history(),
			keymap({
				"Mod-z": undo,
				"Shift-Mod-z": redo,
				"Mod-y": redo,
				"Shift-Enter": (state, dispatch) => {
					if (dispatch) dispatch(state.tr.replaceSelectionWith(composerSchema.node("hard_break")).scrollIntoView());
					return true;
				},
			}),
			keymap(baseKeymap),
		];
		const view = new EditorView(host.current, {
			state: EditorState.create({ schema: composerSchema, doc: composerDocument(latest.current.value), plugins }),
			editable: () => !latest.current.readOnly,
			attributes: { role: "textbox", "aria-multiline": "true", class: "composer-editor-input" },
			dispatchTransaction(transaction) {
				const next = view.state.apply(transaction);
				const text = composerDocumentText(next.doc);
				if (
					transaction.docChanged &&
					text.length > latest.current.maxLength &&
					text.length > composerDocumentText(view.state.doc).length
				) {
					view.updateState(view.state);
					return;
				}
				view.updateState(next);
				view.dom.dataset.empty = String(next.doc.content.size === 2);
				if (transaction.docChanged) latest.current.onChange(text);
			},
			handleKeyDown(_view, event) {
				const action = keyboard.keyDown(event);
				if (action === "native") return false;
				if (action === "submit" && !latest.current.readOnly) latest.current.onSubmit();
				return true;
			},
			handlePaste(_view, event) {
				if (latest.current.readOnly) return true;
				const text = event.clipboardData?.getData("text/plain");
				if (text === undefined) return false;
				const doc = composerDocument(text.replace(/\r\n?/g, "\n"));
				view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 1, 1)).scrollIntoView());
				return true;
			},
			handleDOMEvents: {
				compositionstart: () => {
					keyboard.compositionStart();
					latest.current.onComposingChange?.(true);
					return false;
				},
				compositionend: (_view, event) => {
					keyboard.compositionEnd(event.timeStamp);
					latest.current.onComposingChange?.(false);
					return false;
				},
				keyup: () => {
					keyboard.keyUp();
					return false;
				},
				blur: () => {
					keyboard.reset();
					latest.current.onComposingChange?.(false);
					return false;
				},
			},
		});
		editor.current = view;
		return () => {
			editor.current = null;
			view.destroy();
		};
	}, []);
	useLayoutEffect(() => {
		const view = editor.current;
		if (!view) return;
		if (composerDocumentText(view.state.doc) !== props.value) {
			const doc = composerDocument(props.value);
			view.updateState(
				EditorState.create({
					schema: composerSchema,
					doc,
					plugins: view.state.plugins,
					selection: TextSelection.atEnd(doc),
				}),
			);
		}
		view.setProps({ editable: () => !latest.current.readOnly });
		view.dom.id = props.id;
		view.dom.setAttribute("aria-label", props.label);
		view.dom.setAttribute("aria-readonly", String(!!props.readOnly));
		if (props.describedBy) view.dom.setAttribute("aria-describedby", props.describedBy);
		else view.dom.removeAttribute("aria-describedby");
		view.dom.dataset.placeholder = props.placeholder;
		view.dom.dataset.empty = String(props.value.length === 0);
	}, [props.id, props.value, props.readOnly, props.label, props.describedBy, props.placeholder]);
	return <div className="composer-editor" ref={host} />;
}
