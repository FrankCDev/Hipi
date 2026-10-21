import type { SidebarConversation } from "@hipi/work-runtime/contracts";
import { type Range, useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRecentRowGeometry } from "./use-recent-row-geometry.ts";
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
	const [listElement, setListElement] = useState<HTMLUListElement | null>(null);
	const setList = useCallback((element: HTMLUListElement | null) => {
		list.current = element;
		setListElement(element);
	}, []);
	const [margin, setMargin] = useState(0);
	const geometryAnchor = useRef<{ key: string; offset: number } | undefined>(undefined);
	const geometry = useRecentRowGeometry(listElement, () => {
		const root = viewport();
		const previous = enabled ? virtualizer.getVirtualItems() : committedGeometry.current.items;
		const anchor = root
			? previous.find((item) => item.end > root.scrollTop && item.start < root.scrollTop + root.clientHeight)
			: undefined;
		geometryAnchor.current =
			anchor && root ? { key: String(anchor.key), offset: root.scrollTop - anchor.start } : undefined;
		measureMargin();
		// Updating the estimate alone leaves previously measured and unseen positions stale.
		virtualizer.measure();
	});
	const order = useMemo(() => {
		const keys = rows.map((row) => scopeKey(row.conversation));
		return { keys, indices: new Map(keys.map((key, index) => [key, index])) };
	}, [rows]);
	const getItemKey = useCallback((index: number) => order.keys[index] ?? `missing:${index}`, [order]);
	const anchorKey = geometryAnchor.current?.key;
	const rangeExtractor = useCallback(
		(range: Range) =>
			virtualRecentRange(
				range,
				[...protectedKeys, ...(anchorKey ? [anchorKey] : [])].map((key) => order.indices.get(key) ?? -1),
				focusedKey ? (order.indices.get(focusedKey) ?? -1) : -1,
			),
		[order, protectedKeys, focusedKey, anchorKey],
	);
	const virtualizer = useVirtualizer<HTMLElement, HTMLLIElement>({
		count: rows.length,
		getScrollElement: viewport,
		initialOffset: () => viewport()?.scrollTop ?? 0,
		getItemKey,
		rangeExtractor,
		// The positive placeholder is never used for layout: observation starts only after CSS resolves.
		estimateSize: () => geometry?.height ?? 1,
		gap: geometry?.gap ?? 0,
		measureElement: (element, entry, instance) => {
			const height = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
			if (Number.isFinite(height) && height > 0) return height;
			const index = instance.indexFromElement(element);
			return (
				instance.getVirtualItems().find((item) => item.index === index)?.size ?? instance.options.estimateSize(index)
			);
		},
		overscan: 5,
		scrollMargin: margin,
		paddingStart,
		enabled: enabled && !!geometry,
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
		if (listElement) observer.observe(listElement);
		for (const child of Array.from(root.children)) observer.observe(child);
		return () => observer.disconnect();
	}, [viewport, measureMargin, listElement]);
	useLayoutEffect(() => {
		const anchor = geometryAnchor.current;
		if (!anchor || !enabled || !geometry) return;
		geometryAnchor.current = undefined;
		const item = virtualizer.getVirtualItems().find((item) => item.key === anchor.key);
		// The new extent has committed, so the browser cannot clamp against the old, shorter list.
		if (item) virtualizer.scrollToOffset(item.start + anchor.offset);
	}, [enabled, geometry, virtualizer]);
	useLayoutEffect(() => {
		const root = viewport();
		if (!root) return;
		const cancel = () => {
			geometryAnchor.current = undefined;
		};
		for (const event of ["wheel", "touchmove", "pointerdown", "keydown"])
			root.addEventListener(event, cancel, { passive: true });
		return () => {
			for (const event of ["wheel", "touchmove", "pointerdown", "keydown"]) root.removeEventListener(event, cancel);
		};
	}, [viewport]);
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
		setList,
		virtualizer,
		margin,
		items: rendered,
		totalSize: enabled ? totalSize : committedGeometry.current.totalSize,
	};
}
