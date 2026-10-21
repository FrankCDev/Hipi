import { FolderOpen, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { FileWorkbench } from "../../files/file-workbench.tsx";
import type { FileWorkspaceSession } from "../../files/file-workspace-session.ts";
import { FILE_PANEL, type FilePanelController, panelLayout } from "./panel-controller.ts";
import { filePanelLabels } from "./panel-labels.ts";
import { FilePanelSurface } from "./surface.tsx";

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
	const client = useAppClient();
	const l = filePanelLabels(locale);
	const state = useStore(controller.store);
	// Owner replacement resets local reviews/editor views, never presentation changes.
	const [owner, setOwner] = useState({ session, controller, workspaceId, client, revision: 0 });
	if (
		owner.session !== session ||
		owner.controller !== controller ||
		owner.workspaceId !== workspaceId ||
		owner.client !== client
	) {
		setOwner({ session, controller, workspaceId, client, revision: owner.revision + 1 });
	}
	const open = state.open && available !== null;
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
		const release = () => {
			const current = drag.current;
			drag.current = null;
			if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
			if (current) controller.finishResize(true);
		};
		if (layout.overlay || !state.open) release();
		return release;
	}, [controller, layout.overlay, state.open]);
	return (
		<section
			id={id}
			className="file-panel-dock"
			aria-label={l["filePanel.title"]}
			data-full-width={state.fullWidth}
			hidden={!open}
			inert={!open}
			aria-hidden={!open}
			style={{ width: layout.overlay ? 0 : width + FILE_PANEL.handle, display: open ? undefined : "none" }}
		>
			{/* A focusable separator follows the WAI-ARIA window splitter keyboard pattern. */}
			<hr
				hidden={layout.overlay}
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
						controller.resizeFromSplitter(0, available ?? 0);
						trigger.current?.focus({ preventScroll: true });
						return;
					}
					if (event.key === "ArrowLeft" && layout.width === layout.max) {
						event.preventDefault();
						controller.resizeFromSplitter(available ?? 0, available ?? 0);
						return;
					}
					const widths: Record<string, number> = {
						ArrowLeft: state.fullWidth ? (available ?? 0) : layout.width + 24,
						ArrowRight: layout.width - 24,
						Home: FILE_PANEL.min,
						End: layout.max,
					};
					const width = widths[event.key];
					if (width === undefined) return;
					event.preventDefault();
					controller.resizeFromSplitter(width, available ?? 0);
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
					controller.resizeFromSplitter(current.width + current.x - event.clientX, available ?? 0, false);
					if (!controller.store.getState().open) {
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
			<FilePanelSurface
				open={open}
				overlay={layout.overlay}
				id={id}
				trigger={trigger}
				onClose={() => controller.setOpen(false)}
			>
				<header className="file-panel-header">
					<div className="file-panel-title">
						<FolderOpen aria-hidden="true" size={18} />
						<h2 id={`${id}-title`}>{l["filePanel.title"]}</h2>
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
				<p id={`${id}-description`} className="sr-only">
					{l["filePanel.description"]}
				</p>
				{open && <FileWorkbench key={owner.revision} workspaceId={workspaceId} session={session} guard={guard} />}
			</FilePanelSurface>
		</section>
	);
}
