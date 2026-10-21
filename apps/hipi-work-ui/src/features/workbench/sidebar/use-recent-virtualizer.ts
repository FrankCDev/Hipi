import type { SidebarConversation } from "@hipi/work-runtime/contracts";
import { type Range, useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { virtualRecentRange } from "./virtual-recent-range.ts";
import { scopeKey } from "./window-query.ts";

/** Virtual positions cover only user-revealed, real metadata. There is no estimated global catalog. */
export function useRecentVirtualizer(
	rows: readonly SidebarConversation[],
	viewport: () => HTMLElement | null,
	protectedKeys: readonly string[],
	enabled: boolean,
	paddingStart = 0,
	focusedKey?: string,
) {
	const list = useRef<HTMLUListElement>(null);
	const [margin, setMargin] = useState(0);
	const order = useMemo(() => {
		const keys = rows.map((row) => scopeKey(row.conversation));
		return { keys, indices: new Map(keys.map((key, index) => [key, index])) };
	}, [rows]);
	const getItemKey = useCallback((index: number) => order.keys[index] ?? `missing:${index}`, [order]);
	const rangeExtractor = useCallback(
		(range: Range) =>
			virtualRecentRange(
				range,
				protectedKeys.map((key) => order.indices.get(key) ?? -1),
				focusedKey ? (order.indices.get(focusedKey) ?? -1) : -1,
			),
		[order, protectedKeys, focusedKey],
	);
	const virtualizer = useVirtualizer<HTMLElement, HTMLLIElement>({
		count: rows.length,
		getScrollElement: viewport,
		getItemKey,
		rangeExtractor,
		// Current row CSS has an explicit 36px height; every mounted row is still measured.
		estimateSize: () => 36,
		overscan: 5,
		scrollMargin: margin,
		paddingStart,
		enabled,
	});
	const measureMargin = useCallback(() => {
		const root = viewport();
		if (root && list.current)
			setMargin(list.current.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop);
	}, [viewport]);
	useLayoutEffect(measureMargin);
	useLayoutEffect(() => {
		const root = viewport();
		if (!root || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measureMargin);
		observer.observe(root);
		for (const child of Array.from(root.children)) observer.observe(child);
		return () => observer.disconnect();
	}, [viewport, measureMargin]);
	const items = virtualizer.getVirtualItems();
	const totalSize = virtualizer.getTotalSize();
	const committedGeometry = useRef<{ items: VirtualItem[]; totalSize: number }>({ items: [], totalSize: 0 });
	useLayoutEffect(() => {
		if (enabled && (items.length || !rows.length)) committedGeometry.current = { items, totalSize };
	}, [enabled, items, totalSize, rows.length]);
	const owners = new Set(protectedKeys);
	const retained = committedGeometry.current.items.flatMap((item) => {
		const key = String(item.key);
		const index = order.indices.get(key);
		return owners.has(key) && index !== undefined ? [{ ...item, index }] : [];
	});
	// Disabling observation must not unmount a real dialog/focus owner or collapse the visited extent.
	const rendered = enabled && items.length ? items : retained;
	return {
		list,
		virtualizer,
		margin,
		items: rendered,
		totalSize: enabled ? totalSize : committedGeometry.current.totalSize,
	};
}
