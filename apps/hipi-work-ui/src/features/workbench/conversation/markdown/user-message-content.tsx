import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../../../app/preferences.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { MessageMarkdown } from "./markdown.tsx";

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
			const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
			if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
			const rect = node.getBoundingClientRect();
			const scale = node.offsetHeight === 0 ? 1 : rect.height / node.offsetHeight;
			if (!Number.isFinite(scale) || scale <= 0) return;
			const overflowing = bounded || rect.height / scale > lineHeight * USER_MESSAGE_COLLAPSED_LINES + 1;
			setOverflow(overflowing);
			if (expanded || !overflowing) {
				clip.style.removeProperty("max-height");
				return;
			}
			// Reserve one of the 20 lines for the separate ellipsis. A rendered card
			// crossing the cutoff stays whole, but never extend a source-sliced preview.
			let height = lineHeight * (USER_MESSAGE_COLLAPSED_LINES - 1);
			const cards = bounded
				? []
				: node.querySelectorAll('[data-markdown-copy="code-block"]:not(pre), .markdown-code-block');
			if (cards.length > 0) {
				height = Math.ceil(height);
				for (const card of cards) {
					const bounds = card.getBoundingClientRect();
					const top = (bounds.top - rect.top) / scale;
					const bottom = (bounds.bottom - rect.top) / scale;
					if (top < height && bottom > height) height = Math.ceil(bottom);
				}
			}
			clip.style.maxHeight = cards.length > 0 ? `${height}px` : `${USER_MESSAGE_COLLAPSED_LINES - 1}lh`;
			restore = constrainClippedControls(node, clip.getBoundingClientRect().top + height * scale);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		const mutations = new MutationObserver(measure);
		mutations.observe(node, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			mutations.disconnect();
			restore();
		};
	}, [bounded, expanded, displayed]);
	return (
		<div className="user-message-surface">
			<div className="user-message-fold" data-collapsed={overflow && !expanded} ref={viewport}>
				<div ref={content} className="user-message-body">
					<MessageMarkdown source={displayed} tone="user" />
				</div>
			</div>
			{overflow && !expanded && (
				<span className="user-message-ellipsis" aria-hidden="true" data-markdown-copy="exclude">
					…
				</span>
			)}
			{overflow && (
				<Button
					className="user-message-expand"
					variant="ghost"
					size="sm"
					aria-expanded={expanded}
					data-markdown-copy="exclude"
					onClick={() => setExpanded((value) => !value)}
				>
					{t(expanded ? "work.showLess" : "work.showMore")}
					<ChevronDown className="user-message-expand-icon" aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}
