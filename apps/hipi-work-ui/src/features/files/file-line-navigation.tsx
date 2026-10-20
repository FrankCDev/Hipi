import type { Position, TextDocument } from "@pierre/diffs/edit";
import { CornerDownLeft, ListOrdered, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { DEFAULT_EDITOR_KEYBINDINGS, type FileEditorKeybindings, matchesEditorBinding } from "./editor-keybindings.ts";
import { fileLabels } from "./file-labels.ts";
import "./file-line-navigation.css";

type LineDocument = Pick<TextDocument, "lineCount" | "getLineText" | "positionAt" | "offsetAt">;

/** Adapters use public editor APIs; generation changes after any document edit or replacement. */
export type FileLineNavigationTarget<Snapshot> = {
	identity: object;
	document: LineDocument;
	generation: unknown;
	capture: () => { offset: number; state: Snapshot };
	preview: (position: Position) => void;
	restore: (state: Snapshot) => void;
	focus: () => void;
};

type NavigationSession<Snapshot> = {
	target: FileLineNavigationTarget<Snapshot>;
	snapshot: Snapshot;
	previewed: boolean;
};

/** Accept only decimal integers. Coordinates are one-based, then clamped by the public document. */
export function parseFileLinePosition(value: string, document: LineDocument): Position | undefined {
	const match = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(value);
	if (!match) return;
	const lineNumber = Number(match[1]);
	const column = Number(match[2] ?? 1);
	if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) return;
	const line = Math.min(Math.max(lineNumber, 1), Math.max(document.lineCount, 1)) - 1;
	const character = Math.min(Math.max(column, 1) - 1, document.getLineText(line).length);
	return document.positionAt(document.offsetAt({ line, character }));
}

/** Preview is reversible only within the captured editor and document generation. */
export function useFileLineNavigation<Snapshot>({
	bindings,
	getTarget,
}: {
	bindings: FileEditorKeybindings;
	getTarget: () => FileLineNavigationTarget<Snapshot> | undefined;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const [expanded, setExpanded] = useState(false);
	const [query, setQuery] = useState("");
	const [failure, setFailure] = useState<"invalid" | "changed">();
	const input = useRef<HTMLInputElement>(null);
	const session = useRef<NavigationSession<Snapshot> | undefined>(undefined);
	const composing = useRef(false);
	const mounted = useRef(true);
	const latestTarget = useRef(getTarget);
	latestTarget.current = getTarget;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			session.current = undefined;
		};
	}, []);
	useEffect(() => {
		if (expanded) {
			input.current?.focus({ preventScroll: true });
			input.current?.select();
		}
	}, [expanded]);
	const currentTarget = () => {
		if (!mounted.current) return;
		const saved = session.current;
		const target = latestTarget.current();
		if (
			saved &&
			target &&
			target.identity === saved.target.identity &&
			target.document === saved.target.document &&
			Object.is(target.generation, saved.target.generation)
		)
			return target;
	};
	const open = () => {
		if (!mounted.current || composing.current) return;
		if (!currentTarget()) {
			const target = latestTarget.current();
			if (!target) return;
			const captured = target.capture();
			const position = target.document.positionAt(captured.offset);
			session.current = { target, snapshot: captured.state, previewed: false };
			setQuery(`${position.line + 1}:${position.character + 1}`);
			setFailure(undefined);
		}
		setExpanded(true);
		input.current?.focus({ preventScroll: true });
		input.current?.select();
	};
	const preview = (value: string) => {
		const target = currentTarget();
		if (!target) {
			setFailure("changed");
			return false;
		}
		const position = parseFileLinePosition(value, target.document);
		if (!position) {
			setFailure("invalid");
			return false;
		}
		setFailure(undefined);
		target.preview(position);
		if (session.current) session.current.previewed = true;
		return true;
	};
	const finish = (commit: boolean) => {
		if (!mounted.current || composing.current) return;
		const target = currentTarget();
		if (commit && !preview(query)) return;
		const saved = session.current;
		if (!commit && target && saved?.previewed) target.restore(saved.snapshot);
		session.current = undefined;
		setExpanded(false);
		setFailure(undefined);
		target?.focus();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
		if (!matchesEditorBinding(event, bindings.goToLine ?? DEFAULT_EDITOR_KEYBINDINGS.goToLine)) return false;
		event.preventDefault();
		event.stopPropagation();
		open();
		return true;
	};
	return {
		open,
		onKeyDown,
		panel: expanded ? (
			<fieldset
				className="file-line-navigation"
				aria-label={l["line.title"]}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						finish(false);
					} else onKeyDown(event);
				}}
			>
				<ListOrdered size={14} aria-hidden />
				<Input
					ref={input}
					aria-label={l["line.position"]}
					aria-description={failure ? l[`line.${failure}`] : l["line.hint"]}
					aria-invalid={failure === "invalid"}
					placeholder={l["line.placeholder"]}
					autoComplete="off"
					spellCheck={false}
					maxLength={40}
					value={query}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={(event) => {
						composing.current = false;
						setQuery(event.currentTarget.value);
						preview(event.currentTarget.value);
					}}
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						if (!composing.current && !("isComposing" in event.nativeEvent && event.nativeEvent.isComposing))
							preview(event.currentTarget.value);
					}}
					onKeyDown={(event) => {
						if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
						if (event.key === "Enter") {
							event.preventDefault();
							event.stopPropagation();
							finish(true);
						}
					}}
				/>
				<Button size="icon-xs" variant="ghost" aria-label={l["line.go"]} onClick={() => finish(true)}>
					<CornerDownLeft size={12} aria-hidden />
				</Button>
				<Button size="icon-xs" variant="ghost" aria-label={l["line.cancel"]} onClick={() => finish(false)}>
					<X size={12} aria-hidden />
				</Button>
				<p className="file-line-navigation-hint" role={failure ? "alert" : undefined}>
					{failure ? l[`line.${failure}`] : l["line.hint"]}
				</p>
			</fieldset>
		) : (
			<Button
				className="file-line-navigation-trigger"
				size="icon-xs"
				variant="ghost"
				aria-label={l["line.title"]}
				title={l["line.title"]}
				onClick={open}
			>
				<ListOrdered size={12} aria-hidden />
			</Button>
		),
	};
}
