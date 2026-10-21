import { useLayoutEffect, useRef, useState } from "react";

/** Resolve CSS lengths in the list's own inheritance context, including rem, max() and media queries. */
export function useRecentRowGeometry(element: HTMLUListElement | null, beforeChange: () => void) {
	const [geometry, setGeometry] = useState<{ height: number; gap: number }>();
	const changing = useRef(beforeChange);
	changing.current = beforeChange;
	useLayoutEffect(() => {
		if (!element) return;
		const probe = element.ownerDocument.createElement("li");
		probe.dataset.recentGeometry = "";
		probe.setAttribute("aria-hidden", "true");
		probe.setAttribute("role", "presentation");
		probe.inert = true;
		probe.style.cssText =
			"all:initial;position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;contain:strict;" +
			"width:var(--sidebar-row-gap);height:var(--sidebar-row-height)";
		element.append(probe);
		let previous: { height: number; gap: number } | undefined;
		const measure = () => {
			const { height, width: gap } = probe.getBoundingClientRect();
			// Collapsed/hidden ancestors have no layout. Keep the last usable geometry, never cache zero rows.
			if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(gap) || gap < 0) return;
			if (previous?.height === height && previous.gap === gap) return;
			previous = { height, gap };
			changing.current();
			setGeometry(previous);
		};
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		observer?.observe(probe);
		measure();
		return () => {
			observer?.disconnect();
			probe.remove();
		};
	}, [element]);
	return geometry;
}
