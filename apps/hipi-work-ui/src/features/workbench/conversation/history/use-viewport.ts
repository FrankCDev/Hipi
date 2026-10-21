import type { Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { selectionIntersects } from "../message-projection.ts";
import { type ConversationRow, rowMessages } from "../turns/contracts.ts";
import type { HistoryViewport } from "./window.ts";

/** Read-only geometry/interaction adapter. TanStack and ConversationScrollIntent
 * remain the sole owners of position and anchoring. */
export function useHistoryViewport(
	nodeRef: RefObject<HTMLElement | null>,
	virtualizer: Virtualizer<HTMLElement, HTMLDivElement>,
	rows: readonly ConversationRow[],
	searchPending: RefObject<boolean>,
	onViewport?: (viewport: HistoryViewport | null) => void,
) {
	const current = useRef({ rows, onViewport });
	const frame = useRef<number | undefined>(undefined);
	const dragging = useRef(false);
	useLayoutEffect(() => {
		current.current = { rows, onViewport };
	});
	const report = useCallback(() => {
		const node = nodeRef.current;
		if (!node || !current.current.onViewport) return;
		const pinnedIds = new Set<string>();
		const top = node.scrollTop;
		const bottom = top + node.clientHeight;
		// A virtual turn can contain thousands of messages. Pin actual visible
		// children, not every member of the turn's single measurement wrapper.
		const bounds = node.getBoundingClientRect();
		for (const element of node.querySelectorAll<HTMLElement>("[data-message-id]")) {
			const rect = element.getBoundingClientRect();
			if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom && element.dataset.messageId)
				pinnedIds.add(element.dataset.messageId);
		}
		const focus = document.activeElement;
		if (focus instanceof Element && node.contains(focus)) {
			const element = focus.closest<HTMLElement>("[data-message-id]");
			if (element?.dataset.messageId) pinnedIds.add(element.dataset.messageId);
			else {
				// A focused turn disclosure has no message ancestor. Keep one
				// stable member so trimming cannot remove its owning header.
				const turn = focus.closest<HTMLElement>("[data-turn-key]");
				const row = current.current.rows.find((row) => row.key === turn?.dataset.turnKey);
				const member = row && rowMessages(row).find((child) => child.message)?.message;
				if (member) pinnedIds.add(member.id);
			}
		}
		const selected = selectionIntersects(node, document.getSelection());
		if (selected)
			for (const row of current.current.rows)
				for (const child of rowMessages(row)) if (child.message) pinnedIds.add(child.message.id);
		current.current.onViewport({
			olderDistance: Math.max(0, top),
			newerDistance: Math.max(0, virtualizer.getTotalSize() - virtualizer.options.paddingEnd - bottom),
			pinnedIds,
			paused:
				selected ||
				dragging.current ||
				searchPending.current ||
				document.visibilityState === "hidden" ||
				node.clientHeight <= 0,
		});
	}, [nodeRef, searchPending, virtualizer]);
	const schedule = useCallback(() => {
		if (!current.current.onViewport) return;
		if (frame.current !== undefined) cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			frame.current = undefined;
			report();
		});
	}, [report]);
	useLayoutEffect(schedule);
	useEffect(() => {
		const node = nodeRef.current;
		if (!node || !onViewport) return;
		const start = () => {
			dragging.current = true;
			report();
		};
		const end = () => {
			dragging.current = false;
			schedule();
		};
		const selection = () => {
			report();
			schedule();
		};
		for (const event of ["scroll", "focusin", "focusout"] as const) node.addEventListener(event, schedule);
		node.addEventListener("dragstart", start);
		window.addEventListener("dragend", end);
		window.addEventListener("drop", end);
		document.addEventListener("selectionchange", selection);
		document.addEventListener("visibilitychange", selection);
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		return () => {
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
			frame.current = undefined;
			observer.disconnect();
			for (const event of ["scroll", "focusin", "focusout"] as const) node.removeEventListener(event, schedule);
			node.removeEventListener("dragstart", start);
			window.removeEventListener("dragend", end);
			window.removeEventListener("drop", end);
			document.removeEventListener("selectionchange", selection);
			document.removeEventListener("visibilitychange", selection);
			onViewport(null);
		};
	}, [nodeRef, onViewport, report, schedule]);
	return schedule;
}
