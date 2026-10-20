import { useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";

export const USER_MESSAGE_COLLAPSED_LINES = 20;
export const USER_MESSAGE_COLLAPSED_UNITS = USER_MESSAGE_COLLAPSED_LINES * 512;

/** Only controls hidden by the clip are inert; visible text remains selectable. */
export function constrainClippedControls(root: HTMLElement, bottom: number) {
	const restores: Array<() => void> = [];
	for (const control of root.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]")) {
		if (control.getBoundingClientRect().bottom <= bottom) continue;
		const inert = control.inert;
		const hidden = control.getAttribute("aria-hidden");
		control.inert = true;
		control.setAttribute("aria-hidden", "true");
		restores.push(() => {
			control.inert = inert;
			if (hidden === null) control.removeAttribute("aria-hidden");
			else control.setAttribute("aria-hidden", hidden);
		});
	}
	return () => {
		for (const restore of restores) restore();
	};
}

/** Source and measured-line bounds are independent. Expanding never reads another message. */
export function UserMessageContent({ source }: { source: string }) {
	const { t } = usePreferences();
	const [expanded, setExpanded] = useState(false);
	const [overflow, setOverflow] = useState(source.length > USER_MESSAGE_COLLAPSED_UNITS);
	const viewport = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const bounded = !expanded && source.length > USER_MESSAGE_COLLAPSED_UNITS;
	const displayed = bounded ? source.slice(0, USER_MESSAGE_COLLAPSED_UNITS) : source;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Replaced content can introduce clipped controls without changing the measured height.
	useLayoutEffect(() => {
		const node = content.current;
		const clip = viewport.current;
		if (!node || !clip) return;
		let restore = () => {};
		const measure = () => {
			restore();
			const height = Number.parseFloat(getComputedStyle(node).lineHeight) * USER_MESSAGE_COLLAPSED_LINES;
			if (!Number.isFinite(height) || height <= 0) return;
			setOverflow(bounded || node.getBoundingClientRect().height > height + 1);
			restore = expanded ? () => {} : constrainClippedControls(node, clip.getBoundingClientRect().top + height);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => {
			observer.disconnect();
			restore();
		};
	}, [bounded, expanded, displayed]);
	return (
		<div className="user-message-surface">
			<div className="user-message-fold" data-expanded={expanded} ref={viewport}>
				<div ref={content} className="user-message-body">
					<MessageMarkdown source={displayed} tone="user" />
				</div>
			</div>
			{overflow && (
				<Button
					className="user-message-expand"
					variant="ghost"
					size="sm"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{t(expanded ? "work.showLess" : "work.showMore")}
				</Button>
			)}
		</div>
	);
}
