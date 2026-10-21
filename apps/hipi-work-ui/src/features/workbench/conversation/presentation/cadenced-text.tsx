import { useInView, usePageInView } from "framer-motion";
import { useRef } from "react";
import "./cadenced-text.css";

/** Decorative only: callers own phase truth and screen-reader announcements. */
export function CadencedText({ children, active = true }: { children: string; active?: boolean }) {
	return active ? (
		<ActiveCadencedText>{children}</ActiveCadencedText>
	) : (
		<span className="cadenced-text" data-animate="false">
			{children}
		</span>
	);
}

function ActiveCadencedText({ children }: { children: string }) {
	const root = useRef<HTMLSpanElement>(null);
	const inView = useInView(root);
	const pageVisible = usePageInView();
	return (
		<span ref={root} className="cadenced-text" data-animate={inView && pageVisible}>
			{children}
			<span className="cadenced-text-sweep" aria-hidden="true">
				<span className="cadenced-text-highlight">{children}</span>
			</span>
		</span>
	);
}
