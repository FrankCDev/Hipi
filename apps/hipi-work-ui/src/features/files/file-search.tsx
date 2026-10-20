import { resolveFindAgainShortcut } from "@pierre/diffs/edit";
import {
	ArrowDown,
	ArrowUp,
	CaseSensitive,
	ChevronDown,
	Regex,
	Replace,
	ReplaceAll,
	Search,
	WholeWord,
	X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS, type FileEditorKeybindings, matchesEditorBinding } from "./editor-keybindings.ts";
import { fileLabels } from "./file-labels.ts";
import {
	type FileSearchChange,
	fileSearchReplacements,
	type SearchableFileDocument,
} from "./file-search-replacement.ts";

type Match = [number, number];
export type FileSearchMemory = {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
};
const initialSearch: FileSearchMemory = { query: "", caseSensitive: false, wholeWord: false, regex: false };

/** Both editor engines share localized controls while Pierre owns matching semantics. */
export function useFileSearch({
	document,
	text,
	bindings,
	select,
	focus,
	memory,
	replace,
	readOnly = false,
}: {
	document: SearchableFileDocument;
	text: string;
	bindings: FileEditorKeybindings;
	select: (range: Match) => void;
	focus: () => void;
	memory?: { search?: FileSearchMemory };
	replace?: (changes: FileSearchChange[]) => boolean | undefined;
	readOnly?: boolean;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const [open, setOpen] = useState(false);
	const [state, setState] = useState(memory?.search ?? initialSearch);
	const [current, setCurrent] = useState(-1);
	const [replacing, setReplacing] = useState(false);
	const [replacement, setReplacement] = useState("");
	const [replacementFailure, setReplacementFailure] = useState<"limit" | "changed">();
	const input = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	let matches: Match[] = [];
	let failed = false;
	if (state.query) {
		try {
			if (state.regex) new RegExp(state.query);
			matches = document.search({ text: state.query, replaceText: "", ...state });
		} catch {
			failed = true;
		}
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: Text/query notifications invalidate the selected result even when the public document object is retained.
	useEffect(() => {
		setCurrent(-1);
	}, [text, state]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Editing either input dismisses feedback without moving the selected match.
	useEffect(() => {
		setReplacementFailure(undefined);
	}, [text, state, replacement]);
	useEffect(() => {
		if (memory) memory.search = state;
	}, [state, memory]);
	useEffect(() => {
		if (open) input.current?.focus();
	}, [open]);
	const move = (direction: number) => {
		if (!matches.length) return;
		const next =
			current < 0 ? (direction > 0 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length;
		const range = matches[next];
		if (!range) return;
		setCurrent(next);
		select(range);
	};
	const close = () => {
		composing.current = false;
		setOpen(false);
		focus();
	};
	const applyReplacement = (all: boolean) => {
		if (readOnly || !replace || !matches.length || failed) return;
		if (document.getText() !== text) {
			setCurrent(-1);
			setReplacementFailure("changed");
			return;
		}
		const range = matches[current < 0 ? 0 : current];
		if (!range) return;
		try {
			if (replace(fileSearchReplacements(document, all ? matches : [range], state, replacement)) === false)
				setReplacementFailure("changed");
		} catch (error) {
			setReplacementFailure(error instanceof RangeError ? "limit" : "changed");
		}
		setCurrent(-1);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
		const again = resolveFindAgainShortcut(event.nativeEvent);
		if (matchesEditorBinding(event, bindings.replace ?? DEFAULT_EDITOR_KEYBINDINGS.replace)) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(true);
			setReplacing(true);
			input.current?.focus();
		} else if (matchesEditorBinding(event, bindings.find)) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(true);
			input.current?.focus();
		} else if (open && again) {
			event.preventDefault();
			event.stopPropagation();
			move(again === "previous" ? -1 : 1);
		}
	};
	return {
		open: () => setOpen(true),
		onKeyDown,
		panel: open ? (
			<search
				className="file-find"
				aria-label={l["find.title"]}
				data-file-editor-cancel="find"
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						close();
					} else onKeyDown(event);
				}}
			>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={l["find.replace"]}
					aria-expanded={replacing}
					onClick={() => setReplacing(!replacing)}
				>
					<ChevronDown size={12} aria-hidden />
				</Button>
				<div className="file-find-query">
					<Input
						ref={input}
						aria-label={l["find.title"]}
						aria-invalid={failed}
						maxLength={1024}
						value={state.query}
						onChange={(event) => setState({ ...state, query: event.currentTarget.value })}
						onKeyDown={(event) => {
							if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
							if (event.key === "Enter") {
								event.preventDefault();
								move(event.shiftKey ? -1 : 1);
							}
						}}
					/>
					{(
						[
							["caseSensitive", "find.case", CaseSensitive],
							["wholeWord", "find.word", WholeWord],
							["regex", "find.regex", Regex],
						] as const
					).map(([key, label, Icon]) => (
						<Button
							key={key}
							size="icon-xs"
							variant="ghost"
							aria-label={l[label]}
							title={l[label]}
							aria-pressed={state[key]}
							onClick={() => setState({ ...state, [key]: !state[key] })}
						>
							<Icon size={12} aria-hidden />
						</Button>
					))}
				</div>
				<output aria-live="polite">
					{failed
						? l["find.invalid"]
						: !matches.length
							? l["find.none"]
							: current < 0
								? `${matches.length} ${l["find.matches"]}`
								: `${current + 1} / ${matches.length}`}
				</output>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={l["find.previous"]}
					disabled={!matches.length}
					onClick={() => move(-1)}
				>
					<ArrowUp size={12} aria-hidden />
				</Button>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={l["find.next"]}
					disabled={!matches.length}
					onClick={() => move(1)}
				>
					<ArrowDown size={12} aria-hidden />
				</Button>
				<Button size="icon-xs" variant="ghost" aria-label={l["find.close"]} onClick={close}>
					<X size={12} aria-hidden />
				</Button>
				{replacing && (
					<div className="file-find-replace">
						<Input
							aria-label={l["find.replace"]}
							value={replacement}
							maxLength={1024}
							disabled={readOnly}
							onChange={(event) => setReplacement(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
								if (event.key === "Enter") {
									event.preventDefault();
									applyReplacement(false);
								}
							}}
						/>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label={l["find.replace"]}
							disabled={readOnly || !matches.length || failed}
							onClick={() => applyReplacement(false)}
						>
							<Replace size={12} aria-hidden />
						</Button>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label={l["find.replaceAll"]}
							disabled={readOnly || !matches.length || failed}
							onClick={() => applyReplacement(true)}
						>
							<ReplaceAll size={12} aria-hidden />
						</Button>
					</div>
				)}
				{replacementFailure && <p role="alert">{replacementFailure === "limit" ? l.inputLimit : l["find.changed"]}</p>}
			</search>
		) : (
			<Button
				className="file-find-trigger"
				size="icon-xs"
				variant="ghost"
				aria-label={l["find.title"]}
				title={l["find.title"]}
				onClick={() => setOpen(true)}
			>
				<Search size={12} aria-hidden />
			</Button>
		),
	};
}
