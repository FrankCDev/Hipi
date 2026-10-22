import { useInView, usePageInView } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { selectionIntersects } from "../workbench/conversation/message-projection.ts";
import { inlineActivityLabels } from "./inline-activity-labels.ts";
import { activityLabels } from "./labels.ts";
import type { ActivityOutputChunk, ActivityOutputSession, ActivityOutputSlot } from "./output-session.ts";
import "./retained-output-view.css";

/** At most three adjacent wire chunks are rendered, not an ever-growing transcript. */
export function retainedOutputWindow(chunks: readonly ActivityOutputChunk[], anchor: number) {
	const center = chunks.findIndex((chunk) => chunk.index === anchor);
	if (center < 0) return [];
	let start = center;
	let end = center;
	while (start > 0 && chunks[start - 1]?.index === (chunks[start]?.index ?? 0) - 1) start--;
	while (end + 1 < chunks.length && chunks[end + 1]?.index === (chunks[end]?.index ?? 0) + 1) end++;
	return chunks.slice(start, end + 1);
}

export function RetainedOutputView({
	activityId,
	session,
	slot,
	disabled,
	locale,
}: {
	activityId: string;
	session: ActivityOutputSession;
	slot?: ActivityOutputSlot;
	disabled: boolean;
	locale: string;
}) {
	const labels = activityLabels(locale);
	const inline = inlineActivityLabels(locale);
	const root = useRef<HTMLDivElement>(null);
	const viewport = useRef<HTMLElement>(null);
	const visible = useInView(root, { initial: true });
	const pageVisible = usePageInView();
	const enabled = visible && pageVisible && !disabled;
	const [owner] = useState(() => Symbol("retained-output-viewport"));
	const [anchorIndex, setAnchorIndex] = useState(0);
	const anchor = useRef<{ index: number; top: number } | undefined>(undefined);
	const selected = useRef(false);
	const [selectionPinned, setSelectionPinned] = useState(false);
	const chunks = retainedOutputWindow(slot?.chunks ?? [], anchorIndex);
	const current = useRef({ chunks, slot, enabled });
	current.current = { chunks, slot, enabled };
	const lastScrollTop = useRef(0);
	const adjusting = useRef(false);
	const pendingTarget = useRef<number | undefined>(undefined);
	// Width only, not hidden historical text. Keep a bounded set of recently visited soft-line origins.
	const lineOrigins = useRef(new Map<number, number>());
	const identity = useRef({ session, activityId });
	useLayoutEffect(() => {
		if (identity.current.session === session && identity.current.activityId === activityId) return;
		identity.current = { session, activityId };
		anchor.current = undefined;
		pendingTarget.current = undefined;
		lastScrollTop.current = 0;
		adjusting.current = false;
		lineOrigins.current.clear();
		setAnchorIndex(0);
	}, [session, activityId]);
	const protect = useCallback(() => {
		const element = viewport.current;
		const value = current.current;
		selected.current = selectionIntersects(
			root.current?.closest(".conversation-panel") ?? root.current,
			document.getSelection(),
		);
		setSelectionPinned((previous) => (previous === selected.current ? previous : selected.current));
		const bounds = element?.getBoundingClientRect();
		const spans = element ? [...element.querySelectorAll<HTMLElement>("[data-output-chunk]")] : [];
		const textLeft = element?.querySelector("pre")?.getBoundingClientRect().left;
		for (const span of spans) {
			const firstLine = span.getClientRects()[0];
			if (firstLine && textLeft !== undefined) {
				const index = Number(span.dataset.outputChunk);
				lineOrigins.current.delete(index);
				lineOrigins.current.set(index, Math.max(0, firstLine.left - textLeft));
			}
		}
		while (lineOrigins.current.size > 32) {
			const first = lineOrigins.current.keys().next().value;
			if (first !== undefined) lineOrigins.current.delete(first);
		}
		const inView = bounds
			? spans.filter((span) => {
					const rect = span.getBoundingClientRect();
					return rect.bottom > bounds.top && rect.top < bounds.bottom;
				})
			: [];
		// Zero geometry in a hidden/unmeasured layout must never evict the sole initial chunk.
		const indices = inView.length
			? inView.map((span) => Number(span.dataset.outputChunk))
			: value.chunks.slice(0, 1).map((chunk) => chunk.index);
		if (!selected.current && inView[0] && bounds) {
			const index = Number(inView[0].dataset.outputChunk);
			anchor.current = { index, top: inView[0].getBoundingClientRect().top - bounds.top };
			setAnchorIndex((previous) => (previous === index ? previous : index));
		}
		session.viewport(owner, {
			activityId,
			indices: selected.current ? value.chunks.map((chunk) => chunk.index) : indices,
			selected: selected.current,
			visible: value.enabled,
		});
	}, [session, owner, activityId]);
	useEffect(() => {
		protect();
		session.lease(owner, visible || selectionPinned ? [activityId] : []);
	}, [session, owner, activityId, protect, visible, selectionPinned]);
	useEffect(
		() => () => {
			session.release(owner);
			session.viewport(owner);
		},
		[session, owner],
	);
	useEffect(() => {
		if (!enabled) pendingTarget.current = undefined;
		protect();
		document.addEventListener("selectionchange", protect);
		return () => document.removeEventListener("selectionchange", protect);
	}, [protect, enabled]);
	useLayoutEffect(() => {
		const element = viewport.current;
		const saved = anchor.current;
		if (element && saved && !selected.current) {
			const span = [...element.querySelectorAll<HTMLElement>("[data-output-chunk]")].find(
				(node) => Number(node.dataset.outputChunk) === saved.index,
			);
			if (span) {
				const change = span.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top;
				if (change) {
					adjusting.current = true;
					element.scrollTop += change;
				}
			}
		}
		protect();
		if (element) lastScrollTop.current = element.scrollTop;
		if (pendingTarget.current !== undefined && slot?.chunks?.some((chunk) => chunk.index === pendingTarget.current))
			pendingTarget.current = undefined;
	}, [slot, protect]);
	useEffect(() => {
		// A view made visible again restores its own position, not another reader's latest page.
		if (enabled && !slot?.failed && !slot?.busy && !slot?.chunks?.some((chunk) => chunk.index === anchorIndex))
			session.reveal(activityId, anchorIndex);
	}, [enabled, slot, session, activityId, anchorIndex]);
	const revealEdge = (direction: "before" | "after") => {
		const element = viewport.current;
		if (
			!element ||
			!current.current.enabled ||
			selected.current ||
			current.current.slot?.busy ||
			current.current.slot?.failed
		)
			return;
		const first = current.current.chunks[0];
		const last = current.current.chunks.at(-1);
		// One viewport of threshold is local geometry, not an estimated global transcript length.
		const threshold = Math.max(1, element.clientHeight);
		const target =
			direction === "before" && element.scrollTop <= threshold && first && first.index > 0
				? first.index - 1
				: direction === "after" &&
						element.scrollHeight - element.clientHeight - element.scrollTop <= threshold &&
						last?.page.nextCursor
					? last.index + 1
					: undefined;
		if (target === undefined || pendingTarget.current === target) return;
		pendingTarget.current = target;
		protect();
		session.reveal(activityId, target);
	};
	return (
		<div ref={root} className="retained-output-view">
			{chunks.length > 0 && (
				<div className="inline-tool-text-card">
					<div className="inline-tool-text-header">
						<div className="inline-tool-text-title">{inline["inline.plaintext"]}</div>
					</div>
					<section
						ref={viewport}
						className="retained-output-viewport"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: A native scroll region must be keyboard reachable.
						tabIndex={0}
						aria-label={inline["inline.plaintext"]}
						aria-busy={slot?.busy || undefined}
						onScroll={() => {
							const element = viewport.current;
							if (!element) return;
							const before = lastScrollTop.current;
							lastScrollTop.current = element.scrollTop;
							protect();
							if (adjusting.current) {
								adjusting.current = false;
								return;
							}
							revealEdge(element.scrollTop < before ? "before" : "after");
						}}
						onWheel={(event) => {
							adjusting.current = false;
							if (event.deltaY) revealEdge(event.deltaY < 0 ? "before" : "after");
						}}
						onKeyDown={(event) => {
							adjusting.current = false;
							if (["ArrowDown", "PageDown", "End"].includes(event.key)) revealEdge("after");
							if (["ArrowUp", "PageUp", "Home"].includes(event.key)) revealEdge("before");
						}}
					>
						{/* Inline boundaries add no newline or separators to the original retained text. */}
						<pre className="inline-tool-text retained-output-text">
							{/* A removed partial line must not pull the next chunk to the left margin. */}
							<span
								aria-hidden="true"
								className="retained-output-line-origin"
								style={{ width: lineOrigins.current.get(chunks[0]?.index ?? 0) ?? 0 }}
							/>
							{chunks.map((chunk) => (
								<span key={chunk.index} data-output-chunk={chunk.index}>
									{chunk.page.text}
								</span>
							))}
						</pre>
					</section>
				</div>
			)}
			{slot?.busy && <output className="retained-output-status">{labels["activity.loading"]}</output>}
			{slot?.failed && (
				<div className="retained-output-status">
					<p role="alert">{labels["activity.failed"]}</p>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled || slot.busy}
						onClick={() => {
							pendingTarget.current = undefined;
							session.retry(activityId);
						}}
					>
						{labels["activity.retry"]}
					</Button>
				</div>
			)}
		</div>
	);
}
