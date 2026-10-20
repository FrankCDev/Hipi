import { Ellipsis, FileText, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { ClipboardCopy } from "../workbench/clipboard-copy.tsx";
import { CodeDiff, CodeEditor } from "./code-editor.tsx";
import type { EditorViewMemory } from "./editor-view-memory.ts";
import { fileLabels } from "./file-labels.ts";
import type { EditorTab } from "./file-workspace-session.ts";
import { isMarkdownFile } from "./markdown-presentation.ts";
import { MarkdownPreview } from "./markdown-preview.tsx";

export function FileBuffer({
	tab,
	guard,
	retry,
	focusRequest,
	onFocusHandled,
}: {
	tab: EditorTab;
	guard: (action: () => void) => void;
	retry: () => void;
	focusRequest?: number;
	onFocusHandled?: (request: number) => void;
}) {
	const session = tab.editor;
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const markdown = isMarkdownFile(tab.target.path);
	const [mode, setMode] = useState<NonNullable<EditorViewMemory["mode"]>>(
		markdown || tab.view.mode !== "preview" ? (tab.view.mode ?? "source") : "source",
	);
	const show = (next: NonNullable<EditorViewMemory["mode"]>) => {
		tab.view.mode = next;
		setMode(next);
	};
	const surface = useRef<HTMLDivElement>(null);
	const [adopt, setAdopt] = useState(false);
	const document = state.document;
	useEffect(() => {
		if (focusRequest === undefined || !document || mode === "source" || !surface.current) return;
		const element = surface.current;
		const frame = requestAnimationFrame(() => {
			if (surface.current !== element) return;
			element.focus({ preventScroll: true });
			onFocusHandled?.(focusRequest);
		});
		return () => cancelAnimationFrame(frame);
	}, [focusRequest, onFocusHandled, mode, document]);
	const artifactReference = tab.reference ?? document?.artifactReference;
	const error =
		state.unknown !== undefined
			? l.unknown
			: state.error === "VERSION_CONFLICT"
				? l.conflict
				: state.error === "LIMIT_EXCEEDED"
					? l.limit
					: ["UNSUPPORTED_ENCODING", "BLOCKED_RESOURCE"].includes(state.error ?? "")
						? l.blocked
						: state.error === "BUSY"
							? l.busy
							: l.failed;
	const compare = () => {
		void session.compare();
		show("diff");
	};
	return (
		<section className="file-buffer file-editor-buffer">
			{(state.error || state.unknown !== undefined) && (
				<div
					role="alert"
					className="file-state file-state-alert"
					data-tone={state.unknown !== undefined || state.error === "VERSION_CONFLICT" ? "warning" : "error"}
				>
					<TriangleAlert aria-hidden />
					<div>
						<strong>
							{state.unknown !== undefined
								? l["state.unknown"]
								: state.error === "VERSION_CONFLICT"
									? l["state.conflict"]
									: l["state.failed"]}
						</strong>
						<p>{error}</p>
						{document && (
							<Button variant="outline" size="sm" disabled={!!state.operation} onClick={compare}>
								{l.compare}
							</Button>
						)}
					</div>
				</div>
			)}
			{state.operation && state.operation !== "save" && (
				<div className="file-actions file-operation">
					<output>{l[`operation.${state.operation}`]}</output>
					<Button variant="ghost" size="sm" onClick={() => session.cancel()}>
						{l.cancel}
					</Button>
				</div>
			)}
			{!document ? (
				!state.operation &&
				state.unknown === undefined && (
					<div className="file-state file-state-empty">
						<FileText aria-hidden />
						<h3>{l["state.notLoaded"]}</h3>
						<p>{tab.target.path}</p>
						<Button size="sm" variant="outline" onClick={retry}>
							{l.retry}
						</Button>
					</div>
				)
			) : (
				<>
					<div className="file-editor-toolbar">
						<fieldset className="file-view-switch">
							<legend className="sr-only">{l["toolbar.view"]}</legend>
							<Button size="sm" variant="ghost" aria-pressed={mode === "source"} onClick={() => show("source")}>
								{markdown ? l["view.source"] : l.edit}
							</Button>
							{markdown && (
								<Button size="sm" variant="ghost" aria-pressed={mode === "preview"} onClick={() => show("preview")}>
									{l["view.preview"]}
								</Button>
							)}
							<Button size="sm" variant="ghost" aria-pressed={mode === "diff"} onClick={() => show("diff")}>
								{l.diff}
							</Button>
						</fieldset>
						<div className="file-document-status">
							<span data-dirty={document.text !== document.baseline.text ? "true" : undefined}>
								{state.operation === "save"
									? l["operation.save"]
									: document.text === document.baseline.text
										? l.clean
										: l.dirty}
							</span>
							{!document.writable && <span>{l.readonly}</span>}
						</div>
						{markdown && <ClipboardCopy text={document.text} label={l["view.copyMarkdown"]} iconOnly />}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button size="icon-xs" variant="ghost" aria-label={l["toolbar.edit"]} title={l["toolbar.edit"]}>
									<Ellipsis size={16} aria-hidden />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									disabled={
										!document.writable ||
										!!state.operation ||
										state.unknown !== undefined ||
										state.error === "VERSION_CONFLICT" ||
										document.text === document.baseline.text
									}
									onSelect={() => void session.save()}
								>
									{l.save}
								</DropdownMenuItem>
								<DropdownMenuItem disabled={!!state.operation} onSelect={() => guard(() => session.reload())}>
									{l.reload}
								</DropdownMenuItem>
								<DropdownMenuItem disabled={!!state.operation} onSelect={compare}>
									{l.compare}
								</DropdownMenuItem>
								{state.operation === "save" && (
									<DropdownMenuItem onSelect={() => session.cancel()}>{l.cancel}</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					{artifactReference && (
						<output className="file-artifact-note">
							{l["artifact.current"]}{" "}
							{artifactReference.expectedRevision
								? l[
										(state.disk?.revision ?? document.baseline.revision) === artifactReference.expectedRevision
											? "artifact.matches"
											: "artifact.changed"
									]
								: l["artifact.noRevision"]}
						</output>
					)}
					{state.disk && (state.error === "VERSION_CONFLICT" || state.unknown !== undefined) && (
						<Dialog open={adopt} onOpenChange={setAdopt}>
							<DialogTrigger asChild>
								<Button className="file-reconcile" size="sm" variant="outline" disabled={!!state.operation}>
									{l.adopt}
								</Button>
							</DialogTrigger>
							<DialogContent closeLabel={l.stay}>
								<DialogTitle>{l.adopt}</DialogTitle>
								<DialogDescription>{l.adoptNote}</DialogDescription>
								<Button
									disabled={!!state.operation}
									onClick={() => {
										session.adoptComparedRevision();
										setAdopt(false);
									}}
								>
									{l.adoptConfirm}
								</Button>
							</DialogContent>
						</Dialog>
					)}
					<div className="file-editor-surface" ref={surface} tabIndex={mode === "source" ? undefined : -1}>
						{mode === "diff" ? (
							<>
								<p className="small-copy file-baseline-note">{state.disk ? l.disk : l.baseline}</p>
								<CodeDiff
									name={document.target.path}
									before={state.disk?.text ?? document.diffBaseline.text}
									after={document.text}
									left={l.left}
									right={l.right}
								/>
							</>
						) : mode === "preview" && markdown ? (
							<MarkdownPreview text={document.text} memory={tab.view} />
						) : (
							<CodeEditor
								name={document.target.path}
								key={`${document.target.workspaceId}/${document.target.rootId}/${document.target.path}`}
								text={document.text}
								onChange={(text) => session.edit(text)}
								readOnly={!document.writable}
								memory={tab.view}
								focusRequest={focusRequest}
								onFocusHandled={onFocusHandled}
								onSave={() => void session.save()}
								label={l.editor}
							/>
						)}
					</div>
					<footer className="file-editor-status" title={l.memory}>
						<span>
							{state.error || state.unknown !== undefined
								? l["state.failed"]
								: !document.writable
									? l.readonly
									: state.operation === "save"
										? l["operation.save"]
										: document.text === document.baseline.text
											? l["autosave.saved"]
											: state.autosavePaused
												? l["autosave.paused"]
												: l["autosave.pending"]}
						</span>
						<span>UTF-8</span>
					</footer>
				</>
			)}
		</section>
	);
}
