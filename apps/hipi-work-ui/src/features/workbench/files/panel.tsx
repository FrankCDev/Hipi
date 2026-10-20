import { FolderOpen, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog.tsx";
import { FileWorkbench } from "../../files/file-workbench.tsx";
import type { FileWorkspaceSession } from "../../files/file-workspace-session.ts";
import { FILE_PANEL, type FilePanelController, panelLayout } from "./panel-controller.ts";
import { filePanelLabels } from "./panel-labels.ts";

export function useWorkAreaWidth(ref: RefObject<HTMLElement | null>) {
	const [width, setWidth] = useState<number | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => setWidth(element.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

export function FilePanel({
	controller,
	available,
	workspaceId,
	session,
	guard,
	trigger,
	id,
}: {
	controller: FilePanelController;
	available: number | null;
	workspaceId: string;
	session?: FileWorkspaceSession;
	guard: (action: () => void) => void;
	trigger: RefObject<HTMLButtonElement | null>;
	id: string;
}) {
	const { locale } = usePreferences();
	const l = filePanelLabels(locale);
	const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
	const [retained, setRetained] = useState(state.open);
	const layout = panelLayout(available ?? 0, state.width, state.ratio);
	const width = state.fullWidth && !layout.overlay ? Math.max(0, (available ?? 0) - FILE_PANEL.handle) : layout.width;
	const drag = useRef<{ pointer: number; x: number; width: number; element: HTMLElement } | null>(null);
	const finishDrag = (cancel = false) => {
		const current = drag.current;
		drag.current = null;
		if (!current) return;
		if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
		controller.finishResize(cancel);
	};
	useEffect(() => {
		if (state.open) setRetained(true);
	}, [state.open]);
	useEffect(() => {
		const release = () => {
			const current = drag.current;
			drag.current = null;
			if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
			if (current) controller.finishResize(true);
		};
		if (layout.overlay || !state.open) release();
		return release;
	}, [controller, layout.overlay, state.open]);
	if ((!state.open && !retained) || available === null) return null;
	const content = <FileWorkbench workspaceId={workspaceId} session={session} guard={guard} visible={state.open} />;
	if (layout.overlay)
		return (
			<Dialog open={state.open} onOpenChange={(open) => controller.setOpen(open)}>
				<DialogContent
					id={id}
					className="file-panel-dialog"
					closeLabel={l["filePanel.hide"]}
					showCloseButton={false}
					onEscapeKeyDown={(event) => {
						// Radix handles Escape at document capture, before nested controls can cancel it.
						// Keep the dialog open during IME too; the nested surface owns cancellation.
						if (
							event
								.composedPath()
								.some((target) => target instanceof Element && target.hasAttribute("data-file-editor-cancel"))
						)
							event.preventDefault();
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						trigger.current?.focus({ preventScroll: true });
					}}
				>
					<header className="file-panel-header">
						<div className="file-panel-title">
							<FolderOpen aria-hidden="true" size={18} />
							<DialogTitle>{l["filePanel.title"]}</DialogTitle>
						</div>
						<Button
							size="icon-sm"
							variant="ghost"
							className="file-panel-close"
							aria-label={l["filePanel.hide"]}
							title={l["filePanel.hide"]}
							onClick={() => controller.setOpen(false)}
						>
							<X size={16} aria-hidden="true" />
						</Button>
					</header>
					<DialogDescription className="sr-only">{l["filePanel.description"]}</DialogDescription>
					{content}
				</DialogContent>
			</Dialog>
		);
	return (
		<section
			id={id}
			className="file-panel-dock"
			aria-label={l["filePanel.title"]}
			data-full-width={state.fullWidth}
			hidden={!state.open}
			inert={!state.open}
			aria-hidden={!state.open}
			style={{ width: width + FILE_PANEL.handle, display: state.open ? undefined : "none" }}
		>
			{/* A focusable separator follows the WAI-ARIA window splitter keyboard pattern. */}
			<hr
				tabIndex={0}
				aria-label={l["filePanel.resize"]}
				aria-orientation="vertical"
				aria-valuemin={FILE_PANEL.min}
				aria-valuemax={state.fullWidth ? width : layout.max}
				aria-valuenow={width}
				aria-controls={`${id}-content`}
				aria-describedby={`${id}-resize-hint`}
				className="file-panel-resizer"
				onKeyDown={(event) => {
					// At-edge transitions provide a keyboard equivalent to the pointer gesture.
					if (event.key === "ArrowRight" && state.fullWidth) {
						event.preventDefault();
						controller.restoreSplit();
						return;
					}
					if (event.key === "ArrowRight" && layout.width === FILE_PANEL.min) {
						event.preventDefault();
						controller.resizeFromSplitter(0, available);
						trigger.current?.focus({ preventScroll: true });
						return;
					}
					if (event.key === "ArrowLeft" && layout.width === layout.max) {
						event.preventDefault();
						controller.resizeFromSplitter(available, available);
						return;
					}
					const widths: Record<string, number> = {
						ArrowLeft: state.fullWidth ? available : layout.width + 24,
						ArrowRight: layout.width - 24,
						Home: FILE_PANEL.min,
						End: layout.max,
					};
					const width = widths[event.key];
					if (width === undefined) return;
					event.preventDefault();
					controller.resizeFromSplitter(width, available);
				}}
				onPointerDown={(event) => {
					if (event.button !== 0 || drag.current) return;
					event.preventDefault();
					event.currentTarget.focus({ preventScroll: true });
					event.currentTarget.setPointerCapture(event.pointerId);
					controller.beginResize();
					drag.current = {
						pointer: event.pointerId,
						x: event.clientX,
						width,
						element: event.currentTarget,
					};
				}}
				onPointerMove={(event) => {
					const current = drag.current;
					if (current?.pointer !== event.pointerId) return;
					controller.resizeFromSplitter(current.width + current.x - event.clientX, available, false);
					if (!controller.snapshot().open) {
						finishDrag();
						trigger.current?.focus({ preventScroll: true });
					}
				}}
				onPointerUp={(event) => {
					if (drag.current?.pointer !== event.pointerId) return;
					finishDrag();
				}}
				onPointerCancel={(event) => {
					if (drag.current?.pointer === event.pointerId) finishDrag(true);
				}}
				onLostPointerCapture={(event) => {
					if (drag.current?.pointer === event.pointerId) finishDrag(true);
				}}
			/>
			<span id={`${id}-resize-hint`} className="sr-only">
				{l["filePanel.resizeHint"]}
			</span>
			<div id={`${id}-content`} className="file-panel-content">
				<header className="file-panel-header">
					<div className="file-panel-title">
						<FolderOpen aria-hidden="true" size={18} />
						<h2>{l["filePanel.title"]}</h2>
					</div>
					<Button
						size="icon-sm"
						variant="ghost"
						className="file-panel-close"
						aria-label={l["filePanel.hide"]}
						title={l["filePanel.hide"]}
						onClick={() => {
							controller.setOpen(false);
							trigger.current?.focus({ preventScroll: true });
						}}
					>
						<X size={16} aria-hidden="true" />
					</Button>
				</header>
				{content}
			</div>
		</section>
	);
}
