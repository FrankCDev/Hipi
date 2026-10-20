import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { fileLabels } from "./file-labels.ts";

export function fileTreeLayout(available: number, preferred: number) {
	const safe = Number.isFinite(available) ? Math.max(0, available) : 0;
	const max = Math.max(200, Math.floor(safe * 0.6));
	return {
		overlay: safe < 500,
		min: 200,
		max,
		width: Math.round(Math.min(max, Math.max(200, Number.isFinite(preferred) ? preferred : 240))),
	};
}

/** Independent right-edge tree split. It owns measurement/capture, never resource sessions. */
export function FileSplitView({
	content,
	tree,
	treeOpen,
	width,
	onResize,
	onCollapse,
}: {
	content: ReactNode;
	tree: ReactNode;
	treeOpen: boolean;
	width: number;
	onResize: (width: number) => void;
	onCollapse: () => void;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const host = useRef<HTMLDivElement>(null);
	const drag = useRef<
		{ pointer: number; x: number; width: number; preferred: number; element: HTMLElement } | undefined
	>(undefined);
	const callbacks = useRef({ onResize, onCollapse });
	callbacks.current = { onResize, onCollapse };
	const [available, setAvailable] = useState(640);
	const id = useId();
	const layout = fileTreeLayout(available, width);
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const measure = () => setAvailable(element.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const release = () => {
			const current = drag.current;
			drag.current = undefined;
			if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
			if (current) callbacks.current.onResize(current.preferred);
		};
		if (!treeOpen || layout.overlay) release();
		return release;
	}, [treeOpen, layout.overlay]);
	return (
		<div className="file-split-view" ref={host} data-tree-overlay={layout.overlay}>
			<div className="file-content-view">{content}</div>
			{treeOpen && (
				<>
					{!layout.overlay && (
						<hr
							className="file-tree-resizer"
							tabIndex={0}
							aria-label={l["tree.resize"]}
							aria-orientation="vertical"
							aria-valuemin={layout.min}
							aria-valuemax={layout.max}
							aria-valuenow={layout.width}
							aria-controls={id}
							aria-describedby={`${id}-hint`}
							onKeyDown={(event) => {
								if (event.key === "ArrowRight" && layout.width === layout.min) {
									event.preventDefault();
									onCollapse();
									return;
								}
								const next = {
									ArrowLeft: layout.width + 24,
									ArrowRight: layout.width - 24,
									Home: layout.min,
									End: layout.max,
								}[event.key];
								if (next === undefined) return;
								event.preventDefault();
								onResize(fileTreeLayout(available, next).width);
							}}
							onPointerDown={(event) => {
								if (event.button !== 0 || drag.current) return;
								event.preventDefault();
								event.currentTarget.focus({ preventScroll: true });
								event.currentTarget.setPointerCapture(event.pointerId);
								drag.current = {
									pointer: event.pointerId,
									x: event.clientX,
									width: layout.width,
									preferred: width,
									element: event.currentTarget,
								};
							}}
							onPointerMove={(event) => {
								const current = drag.current;
								if (current?.pointer !== event.pointerId) return;
								const requested = current.width + current.x - event.clientX;
								if (requested < layout.min / 2) {
									drag.current = undefined;
									if (current.element.hasPointerCapture(current.pointer))
										current.element.releasePointerCapture(current.pointer);
									onResize(current.preferred);
									onCollapse();
								} else onResize(fileTreeLayout(available, requested).width);
							}}
							onPointerUp={(event) => {
								if (drag.current?.pointer !== event.pointerId) return;
								drag.current = undefined;
								if (event.currentTarget.hasPointerCapture(event.pointerId))
									event.currentTarget.releasePointerCapture(event.pointerId);
							}}
							onPointerCancel={(event) => {
								const current = drag.current;
								if (current?.pointer !== event.pointerId) return;
								drag.current = undefined;
								if (current.element.hasPointerCapture(current.pointer))
									current.element.releasePointerCapture(current.pointer);
								onResize(current.preferred);
							}}
							onLostPointerCapture={(event) => {
								const current = drag.current;
								if (current?.pointer !== event.pointerId) return;
								drag.current = undefined;
								onResize(current.preferred);
							}}
						/>
					)}
					<span id={`${id}-hint`} className="sr-only">
						{l["tree.resizeHint"]}
					</span>
					<aside id={id} className="file-tree-pane" aria-label={l["browse.title"]} style={{ width: layout.width }}>
						{tree}
					</aside>
				</>
			)}
		</div>
	);
}
