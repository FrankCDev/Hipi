import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
	type InlineControlPolicy,
	type InlineControlPresentations,
	type InlineControlSize,
	resolveInlineControls,
	sameInlinePresentation,
} from "./inline-collapse.ts";

type MeasuredInlineControl = InlineControlPolicy & { ref: RefObject<HTMLElement | null> };
const transientWidth = "[data-inline-collapse-transient-width]";

export function inlineControlGap(element: HTMLElement) {
	const style = getComputedStyle(element);
	const columnGap = Number.parseFloat(style.columnGap);
	const gap = Number.parseFloat(style.gap);
	return Number.isFinite(columnGap) ? columnGap : Number.isFinite(gap) ? gap : 0;
}

/** Measure the one live control tree; never mount a second model/permission owner for sizing. */
export function useInlineCollapse({
	availableWidth,
	container,
	items,
}: {
	availableWidth: number | null;
	container: RefObject<HTMLElement | null>;
	items: readonly MeasuredInlineControl[];
}) {
	const sizes = useRef(new Map<string, InlineControlSize>());
	const [presentation, setPresentation] = useState<InlineControlPresentations>(() =>
		Object.fromEntries(items.map(({ id }) => [id, { hideLabel: false, hideControl: false }])),
	);
	const measure = useEffectEvent(() => {
		const root = container.current;
		if (!root) return;
		for (const item of items) {
			const element = item.ref.current;
			if (!element || element.matches(transientWidth) || element.querySelector(transientWidth)) continue;
			const width = element.offsetWidth;
			if (width <= 0 || presentation[item.id]?.hideControl) continue;
			const previous = sizes.current.get(item.id) ?? {};
			sizes.current.set(item.id, {
				...previous,
				[presentation[item.id]?.hideLabel ? "compact" : "expanded"]: width,
			});
		}
		const next = resolveInlineControls({
			availableWidth,
			gap: inlineControlGap(root),
			items,
			sizes: sizes.current,
			previous: presentation,
		});
		setPresentation((previous) => (sameInlinePresentation(previous, next) ? previous : next));
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: Each committed budget/presentation change requires a fresh live measurement through the Effect Event.
	useLayoutEffect(() => {
		measure();
	}, [availableWidth, items, presentation]);
	const invalidate = useEffectEvent(() => {
		sizes.current.clear();
		setPresentation((previous) => {
			const next = Object.fromEntries(items.map(({ id }) => [id, { hideLabel: false, hideControl: false }]));
			return sameInlinePresentation(previous, next) ? previous : next;
		});
	});
	useEffect(() => {
		const root = container.current;
		if (!root) return;
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
		observer?.observe(root);
		for (const item of items) if (item.ref.current) observer?.observe(item.ref.current);
		const mutations =
			typeof MutationObserver === "undefined"
				? null
				: new MutationObserver((records) => {
						if (records.some((record) => record.type !== "attributes")) invalidate();
						else measure();
					});
		for (const item of items)
			if (item.ref.current)
				mutations?.observe(item.ref.current, {
					subtree: true,
					childList: true,
					characterData: true,
					attributes: true,
					attributeFilter: ["data-inline-collapse-transient-width"],
				});
		// Theme/font changes must invalidate widths even when the live label is collapsed or hidden.
		const theme = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => invalidate());
		theme?.observe(root.ownerDocument.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
		const fonts = root.ownerDocument.fonts;
		fonts?.addEventListener("loadingdone", invalidate);
		return () => {
			observer?.disconnect();
			mutations?.disconnect();
			theme?.disconnect();
			fonts?.removeEventListener("loadingdone", invalidate);
		};
	}, [container, items]);
	return presentation;
}
