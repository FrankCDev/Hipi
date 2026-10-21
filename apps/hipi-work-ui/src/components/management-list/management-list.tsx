import { type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../ui/button.tsx";
import type { ManagementCursorList } from "./cursor-list.ts";

/** A viewport adapter only: the resource owns transport, identities and bounded retention. */
export function ManagementList<T>({
	resource,
	active,
	label,
	retryLabel,
	loadingLabel,
	emptyLabel,
	itemKey,
	children,
}: {
	resource: ManagementCursorList<T>;
	active: boolean;
	label: string;
	retryLabel: string;
	loadingLabel: string;
	emptyLabel: string;
	itemKey: (item: T) => string;
	children: (item: T) => ReactNode;
}) {
	const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
	const viewport = useRef<HTMLElement>(null);
	const anchor = useRef<{ key: string; top: number } | null>(null);
	const direction = useRef<"next" | "previous">("next");
	const lastTop = useRef(0);
	const items = state.pages.flatMap((page) => page.items);
	const capture = () => {
		const root = viewport.current;
		if (!root) return;
		const top = root.getBoundingClientRect().top;
		const row = [...root.querySelectorAll<HTMLElement>("[data-management-key]")].find(
			(item) => item.getBoundingClientRect().bottom > top,
		);
		anchor.current = row ? { key: row.dataset.managementKey ?? "", top: row.getBoundingClientRect().top - top } : null;
	};
	const canCommit = (next: readonly T[]) => {
		const root = viewport.current;
		if (!root) return false;
		const keys = new Set(next.map(itemKey));
		const selection = window.getSelection();
		return ![...root.querySelectorAll<HTMLElement>("[data-management-key]")].some(
			(row) =>
				!keys.has(row.dataset.managementKey ?? "") &&
				(row.contains(document.activeElement) ||
					row.querySelector('[aria-haspopup="dialog"][data-state="open"]') ||
					(selection &&
						!selection.isCollapsed &&
						selection.rangeCount > 0 &&
						selection.getRangeAt(0).intersectsNode(row))),
		);
	};
	const demand = () => {
		const root = viewport.current;
		const snapshot = resource.getSnapshot();
		if (!root || !active || snapshot.busy || snapshot.failed || root.clientHeight === 0) return;

		// Only an interaction in the page being evicted blocks this direction. Keyboard focus
		// in the last row can still demand the next page without losing its current button.
		if (snapshot.pages.length >= 3) {
			const outgoing = snapshot.pages[direction.current === "previous" ? 2 : 0];
			const keys = new Set(outgoing?.items.map(itemKey));
			const selection = window.getSelection();
			const protectedRow = [...root.querySelectorAll<HTMLElement>("[data-management-key]")].some((row) => {
				if (!keys.has(row.dataset.managementKey ?? "")) return false;
				return (
					row.contains(document.activeElement) ||
					row.querySelector('[aria-haspopup="dialog"][data-state="open"]') ||
					(selection &&
						!selection.isCollapsed &&
						selection.rangeCount > 0 &&
						selection.getRangeAt(0).intersectsNode(row))
				);
			});
			if (protectedRow) return;
		}
		capture();
		if (direction.current === "previous" && root.scrollTop < 80 && snapshot.before > 0)
			void resource.load("previous", canCommit);
		else if (root.scrollHeight - root.scrollTop - root.clientHeight < 120) void resource.load("next", canCommit);
	};
	const demandRef = useRef(demand);
	demandRef.current = demand;
	useEffect(() => {
		resource.setActive(active);
		if (active) void resource.load("refresh");
		return () => resource.setActive(false);
	}, [resource, active]);
	useLayoutEffect(() => {
		const root = viewport.current;
		const saved = anchor.current;
		if (!root || !saved || !state.pages.length) return;
		const row = [...root.querySelectorAll<HTMLElement>("[data-management-key]")].find(
			(item) => item.dataset.managementKey === saved.key,
		);
		if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.top;
		lastTop.current = root.scrollTop;
	}, [state.pages]);
	useEffect(() => {
		if (!active || state.busy || !state.pages.length) return;
		const frame = requestAnimationFrame(() => demandRef.current());
		return () => cancelAnimationFrame(frame);
	}, [state.pages, state.busy, active]);
	useEffect(() => {
		const root = viewport.current;
		if (!root || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => demandRef.current());
		observer.observe(root);
		return () => observer.disconnect();
	}, []);
	return (
		<section
			ref={viewport}
			aria-label={label}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard scrolling.
			tabIndex={0}
			className="max-h-96 overflow-y-auto overscroll-contain grid gap-2 focus-visible:outline-ring"
			style={{ overflowAnchor: "none" }}
			onScroll={() => {
				const top = viewport.current?.scrollTop ?? 0;
				direction.current = top < lastTop.current ? "previous" : "next";
				lastTop.current = top;
				demand();
			}}
			onBlur={() => requestAnimationFrame(() => demandRef.current())}
		>
			{state.before > 0 && <div aria-hidden="true" className="h-8 shrink-0" />}
			{items.map((item) => (
				<div key={itemKey(item)} data-management-key={itemKey(item)}>
					{children(item)}
				</div>
			))}
			{state.loaded && !state.failed && items.length === 0 && state.pages.at(-1)?.nextCursor === null && (
				<p>{emptyLabel}</p>
			)}
			{state.busy && <output aria-live="polite">{loadingLabel}</output>}
			{state.failed && (
				<Button
					variant="ghost"
					onClick={() => {
						capture();
						void resource.retry();
					}}
				>
					{retryLabel}
				</Button>
			)}
			{state.pages.at(-1)?.nextCursor && <div aria-hidden="true" className="h-8 shrink-0" />}
		</section>
	);
}
