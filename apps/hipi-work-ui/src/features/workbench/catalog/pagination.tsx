import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useSidebarDragging } from "../sidebar/drag-provider.tsx";

export type CatalogViewportPages = {
	hasMore: boolean;
	hasPrevious: boolean;
	isFetching: boolean;
	isError: boolean;
	itemKeys: readonly string[];
	windowItemKeys?: readonly string[];
	preservesFocus?: boolean;
	cancelLoad?: () => void;
	evictedKeys: (direction: "next" | "previous") => readonly string[];
	loadMore: () => Promise<void>;
	loadPrevious: () => Promise<void>;
	protectItem?: (key: string | undefined) => void;
};

/** Viewport demand only. The query owns cursors, errors, scope and the bounded row window. */
export function CatalogPagination({
	pages,
	listRef,
	enabled = true,
}: {
	pages: CatalogViewportPages;
	listRef: RefObject<HTMLElement | null>;
	enabled?: boolean;
}) {
	const edge = useRef<HTMLDivElement>(null);
	const dragging = useSidebarDragging();
	const current = useRef(pages);
	current.current = pages;
	const pending = useRef(false);
	const pendingDirection = useRef<"next" | "previous">("next");
	const anchor = useRef<{ element: HTMLElement; top: number; scrollTop: number } | null>(null);
	const direction = useRef<"next" | "previous">("next");
	const lastScroll = useRef(0);
	useEffect(() => {
		const cancel = () => {
			if (pending.current) current.current.cancelLoad?.();
		};
		const visibility = () => {
			if (document.visibilityState === "hidden") cancel();
		};
		document.addEventListener("visibilitychange", visibility);
		if (!enabled || dragging) cancel();
		return () => {
			document.removeEventListener("visibilitychange", visibility);
			cancel();
		};
	}, [enabled, dragging]);
	const revision = pages.itemKeys.join("\u0000");
	// biome-ignore lint/correctness/useExhaustiveDependencies: Row commits restore measured geometry even when query fetching was batched.
	useLayoutEffect(() => {
		const saved = anchor.current;
		if (!saved || pages.isFetching) return;
		anchor.current = null;
		const root = listRef.current?.closest<HTMLElement>(".navigation-list, [role='menu']") ?? listRef.current;
		if (root && saved.element.isConnected && root.scrollTop === saved.scrollTop)
			root.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
	}, [pages.isFetching, listRef, revision]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: New committed rows and settled reads re-evaluate viewport demand.
	useEffect(() => {
		const region = listRef.current;
		const root = region?.closest<HTMLElement>(".navigation-list, [role='menu']") ?? region;
		if (!region || !root || dragging || !enabled) return;
		lastScroll.current = root.scrollTop;
		let disposed = false;
		let frame = 0;
		const rows = () => {
			const keys = new Set(current.current.itemKeys);
			return Array.from(region.querySelectorAll<HTMLElement>("[data-catalog-key]")).filter((row) =>
				keys.has(row.dataset.catalogKey ?? ""),
			);
		};
		const check = async () => {
			const state = current.current;
			if (
				disposed ||
				pending.current ||
				state.isFetching ||
				state.isError ||
				document.visibilityState === "hidden" ||
				region.closest("[hidden], [inert]") ||
				!root.getClientRects().length ||
				document.querySelector("[data-sidebar-row-portal]")
			)
				return;
			const visible = rows();
			const box = root.getBoundingClientRect();
			const windowKeys = new Set(state.windowItemKeys ?? state.itemKeys);
			const first = visible.find((row) => windowKeys.has(row.dataset.catalogKey ?? ""))?.getBoundingClientRect();
			const end = edge.current?.getBoundingClientRect();
			const previous =
				direction.current === "previous" &&
				state.hasPrevious &&
				first &&
				first.top >= box.top &&
				first.top <= box.bottom;
			const next =
				direction.current === "next" && state.hasMore && end && end.top <= box.bottom && end.bottom >= box.top;
			if (!previous && !next) return;
			const action = previous ? "previous" : "next";
			const focused = document.activeElement?.closest<HTMLElement>("[data-catalog-key]");
			const focusedKey = focused && region.contains(focused) ? focused.dataset.catalogKey : undefined;
			state.protectItem?.(focusedKey);
			if (!state.protectItem && !state.preservesFocus && focusedKey && state.evictedKeys(action).includes(focusedKey))
				return;
			const retained = visible.find((row) => {
				const bounds = row.getBoundingClientRect();
				return (
					bounds.bottom > box.top &&
					bounds.top < box.bottom &&
					!state.evictedKeys(action).includes(row.dataset.catalogKey ?? "")
				);
			});
			anchor.current = retained
				? { element: retained, top: retained.getBoundingClientRect().top, scrollTop: root.scrollTop }
				: null;
			pendingDirection.current = action;
			pending.current = true;
			try {
				await (action === "previous" ? state.loadPrevious() : state.loadMore());
			} finally {
				pending.current = false;
			}
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				void check();
			});
		};
		const scroll = () => {
			if (pending.current) {
				const keys = new Set(current.current.windowItemKeys ?? current.current.itemKeys);
				const target =
					pendingDirection.current === "next"
						? edge.current
						: rows().find((row) => keys.has(row.dataset.catalogKey ?? ""));
				const bounds = target?.getBoundingClientRect();
				const viewport = root.getBoundingClientRect();
				if (!bounds || bounds.bottom < viewport.top || bounds.top > viewport.bottom) current.current.cancelLoad?.();
			}
			if (root.scrollTop !== lastScroll.current)
				direction.current = root.scrollTop < lastScroll.current ? "previous" : "next";
			lastScroll.current = root.scrollTop;
			schedule();
		};
		root.addEventListener("scroll", scroll, { passive: true });
		root.addEventListener("focusin", schedule);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		observer?.observe(root);
		if (edge.current) observer?.observe(edge.current);
		schedule();
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			root.removeEventListener("scroll", scroll);
			root.removeEventListener("focusin", schedule);
			observer?.disconnect();
		};
	}, [listRef, dragging, enabled, pages.isFetching, pages.isError, revision]);
	return <div ref={edge} aria-hidden="true" data-catalog-boundary="" />;
}
