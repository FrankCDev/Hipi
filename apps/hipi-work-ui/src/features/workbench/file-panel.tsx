import { FolderOpen, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import type { EditorSession } from "../files/editor-session.ts";
import { FileWorkbench } from "../files/file-workbench.tsx";
import { FILE_PANEL, type FilePanelController, panelLayout } from "./file-panel-controller.ts";
import { filePanelLabels } from "./file-panel-labels.ts";

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
	session?: EditorSession;
	guard: (action: () => void) => void;
	trigger: RefObject<HTMLButtonElement | null>;
	id: string;
}) {
	const { locale } = usePreferences();
	const l = filePanelLabels(locale);
	const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
	const layout = panelLayout(available ?? 0, state.width);
	const drag = useRef<{ pointer: number; x: number; width: number; element: HTMLElement } | null>(null);
	useEffect(() => {
		const release = () => {
			const current = drag.current;
			drag.current = null;
			if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
		};
		if (layout.overlay || !state.open) release();
		return release;
	}, [layout.overlay, state.open]);
	if (!state.open || available === null) return null;
	const content = <FileWorkbench workspaceId={workspaceId} session={session} guard={guard} />;
	if (layout.overlay)
		return (
			<Dialog open onOpenChange={(open) => controller.setOpen(open)}>
				<DialogContent
					id={id}
					className="file-panel-dialog"
					closeLabel={l["filePanel.hide"]}
					showCloseButton={false}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						trigger.current?.focus();
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
							<X aria-hidden="true" />
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
			style={{ width: layout.width + FILE_PANEL.handle }}
		>
			{/* A focusable separator follows the WAI-ARIA window splitter keyboard pattern. */}
			<hr
				tabIndex={0}
				aria-label={l["filePanel.resize"]}
				aria-orientation="vertical"
				aria-valuemin={FILE_PANEL.min}
				aria-valuemax={layout.max}
				aria-valuenow={layout.width}
				aria-controls={`${id}-content`}
				aria-describedby={`${id}-resize-hint`}
				className="file-panel-resizer"
				onKeyDown={(event) => {
					const widths: Record<string, number> = {
						ArrowLeft: layout.width + 24,
						ArrowRight: layout.width - 24,
						Home: FILE_PANEL.min,
						End: layout.max,
					};
					const width = widths[event.key];
					if (width === undefined) return;
					event.preventDefault();
					controller.resize(width, available);
				}}
				onPointerDown={(event) => {
					if (event.button !== 0 || drag.current) return;
					event.preventDefault();
					event.currentTarget.focus();
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = {
						pointer: event.pointerId,
						x: event.clientX,
						width: layout.width,
						element: event.currentTarget,
					};
				}}
				onPointerMove={(event) => {
					const current = drag.current;
					if (current?.pointer === event.pointerId)
						controller.resize(current.width + current.x - event.clientX, available, false);
				}}
				onPointerUp={(event) => {
					if (drag.current?.pointer !== event.pointerId) return;
					drag.current = null;
					event.currentTarget.releasePointerCapture(event.pointerId);
					controller.resize(controller.snapshot().width, available);
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
				onLostPointerCapture={() => {
					drag.current = null;
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
							trigger.current?.focus();
						}}
					>
						<X aria-hidden="true" />
					</Button>
				</header>
				{content}
			</div>
		</section>
	);
}
