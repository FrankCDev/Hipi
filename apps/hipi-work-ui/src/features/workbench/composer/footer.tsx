import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { inlineControlGap } from "./use-inline-collapse.ts";
import "./footer.css";

const FooterWidth = createContext<number | null>(null);
export function useComposerFooterWidth() {
	return useContext(FooterWidth);
}

/** Ordinary multiline layout only. The editor form and portalled control forms stay siblings. */
export function ComposerFooter({
	input,
	leading,
	expanding,
	actions,
}: {
	input: ReactNode;
	leading?: ReactNode;
	expanding?: ReactNode;
	actions: ReactNode;
}) {
	const trailing = useRef<HTMLDivElement>(null);
	const actionGroup = useRef<HTMLDivElement>(null);
	const [availableWidth, setAvailableWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const row = trailing.current;
		const controls = actionGroup.current;
		if (!row || !controls) return;
		let rowWidth = row.clientWidth;
		let actionWidth = controls.offsetWidth;
		const publish = () => {
			if (rowWidth <= 0) return;
			setAvailableWidth(Math.max(0, rowWidth - actionWidth - (actionWidth > 0 ? inlineControlGap(row) : 0)));
		};
		publish();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === row) rowWidth = entry.contentRect.width;
				if (entry.target === controls) actionWidth = entry.contentRect.width;
			}
			publish();
		});
		observer.observe(row);
		observer.observe(controls);
		return () => observer.disconnect();
	}, []);
	return (
		<div className="composer-footer-grid" data-composer-layout="multiline">
			<div className="composer-footer-input">{input}</div>
			<div className="composer-footer-leading">{leading}</div>
			<div className="composer-footer-trailing" ref={trailing}>
				<div className="composer-footer-expanding">
					<FooterWidth.Provider value={availableWidth}>{expanding}</FooterWidth.Provider>
				</div>
				<div className="composer-footer-actions" ref={actionGroup}>
					<div className="composer-footer-primary">{actions}</div>
				</div>
			</div>
		</div>
	);
}
