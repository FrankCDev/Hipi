import { useEffect, useLayoutEffect, useRef } from "react";
import { selectionIntersects } from "../workbench/conversation/message-projection.ts";
import { ActivityCard, type ToolActivityArtifact } from "./activity-card.tsx";
import type { ActivitySession, ActivityState } from "./activity-session.ts";
import { InlineActivityCard } from "./inline-activity-card.tsx";
import { activityLabels } from "./labels.ts";

/** Three retained metadata pages; scroll anchors survive eviction in either direction. */
export function ActivityHistoryWindow({
	session,
	state,
	enabled,
	locale,
	onOpenArtifact,
	inline = false,
}: {
	session: ActivitySession;
	state: ActivityState;
	enabled: boolean;
	locale: string;
	onOpenArtifact?: (artifact: ToolActivityArtifact) => void;
	inline?: boolean;
}) {
	const root = useRef<HTMLElement>(null);
	const anchor = useRef<{ id: string; top: number } | undefined>(undefined);
	const demand = useRef<string | undefined>(undefined);
	const scrollTop = useRef(0);
	const batches = useRef(0);
	const pages = state.window;
	useEffect(() => {
		const update = () =>
			session.selectMetadata(
				selectionIntersects(root.current?.closest(".conversation-panel") ?? root.current, document.getSelection()),
			);
		update();
		document.addEventListener("selectionchange", update);
		return () => {
			document.removeEventListener("selectionchange", update);
			session.selectMetadata(false);
		};
	}, [session]);
	useEffect(() => {
		if (enabled && pages) session.outputs.validate(pages.flatMap((entry) => entry.page.items));
	}, [session, enabled, pages]);
	useLayoutEffect(() => {
		if (!pages || !anchor.current || !root.current) return;
		const element = [...root.current.querySelectorAll<HTMLElement>("[data-history-record]")].find(
			(node) => node.dataset.historyRecord === anchor.current?.id,
		);
		if (element) root.current.scrollTop += element.getBoundingClientRect().top - anchor.current.top;
		anchor.current = undefined;
	}, [pages]);
	useEffect(() => {
		const element = root.current;
		if (!element || !enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let visible = false;
		const load = (scrolled = false, direction?: "before" | "after") => {
			if (timer) return;
			if (!visible && !scrolled) return;
			const upward =
				direction === "before" || (direction === undefined && scrolled && element.scrollTop < scrollTop.current);
			scrollTop.current = element.scrollTop;
			if (scrolled) {
				batches.current = 0;
				demand.current = undefined;
			}
			if (
				state.busy ||
				state.failed ||
				document.visibilityState === "hidden" ||
				selectionIntersects(element, document.getSelection())
			)
				return;
			if (batches.current >= 8) return;
			const first = pages?.[0];
			const last = pages?.at(-1);
			const previous = upward && !!first && first.index > 0 && element.scrollTop < 800;
			const next = !!last?.page.nextCursor && element.scrollHeight - element.scrollTop - element.clientHeight < 800;
			const target =
				state.windowTarget ?? (!first ? 0 : previous ? first.index - 1 : next && last ? last.index + 1 : undefined);
			if (target === undefined) return;
			const key = JSON.stringify([target, state.windowTarget, state.cursor, first?.index, last?.index]);
			if (demand.current === key) return;
			demand.current = key;
			batches.current++;
			const visibleRecord = [...element.querySelectorAll<HTMLElement>("[data-history-record]")].find(
				(node) => node.getBoundingClientRect().bottom > element.getBoundingClientRect().top,
			);
			if (visibleRecord?.dataset.historyRecord)
				anchor.current = { id: visibleRecord.dataset.historyRecord, top: visibleRecord.getBoundingClientRect().top };
			timer = setTimeout(() => {
				timer = undefined;
				void (state.windowTarget !== undefined ? session.continueWindow() : session.windowPage(target));
			}, 50);
		};
		const scroll = () => load(true);
		const wheel = (event: WheelEvent) => {
			if (event.deltaY) load(true, event.deltaY < 0 ? "before" : "after");
		};
		const key = (event: KeyboardEvent) => {
			if (["ArrowUp", "PageUp", "Home"].includes(event.key)) load(true, "before");
			if (["ArrowDown", "PageDown", "End"].includes(event.key)) load(true, "after");
		};
		element.addEventListener("scroll", scroll, { passive: true });
		element.addEventListener("wheel", wheel, { passive: true });
		element.addEventListener("keydown", key);
		const observer = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) load();
			else {
				clearTimeout(timer);
				timer = undefined;
				demand.current = undefined;
			}
		});
		observer.observe(element);
		const selection = () => load();
		document.addEventListener("selectionchange", selection);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
			document.removeEventListener("selectionchange", selection);
			element.removeEventListener("scroll", scroll);
			element.removeEventListener("wheel", wheel);
			element.removeEventListener("keydown", key);
		};
	}, [session, enabled, state.busy, state.failed, state.windowTarget, state.cursor, pages]);
	const Card = inline ? InlineActivityCard : ActivityCard;
	return (
		<section
			ref={root}
			className={
				inline
					? "inline-activity-records min-h-0 overflow-y-auto overscroll-contain"
					: "min-h-0 overflow-y-auto overscroll-contain grid gap-3"
			}
			data-activity-history-window=""
			// biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region must be keyboard reachable.
			tabIndex={0}
			aria-label={activityLabels(locale)["activity.title"]}
			style={inline ? { maxHeight: "var(--activity-group-max-height)" } : undefined}
		>
			{pages?.flatMap((entry) =>
				entry.page.items.map((item) => (
					<div key={`${entry.index}:${item.activityId}`} data-history-record={item.activityId}>
						<Card
							activity={item}
							locale={locale}
							state={state}
							session={session}
							disabled={!enabled}
							onOpenArtifact={onOpenArtifact}
						/>
					</div>
				)),
			)}
			{pages?.length && !pages.some((entry) => entry.page.items.length) && !pages.at(-1)?.page.nextCursor ? (
				<p>{activityLabels(locale)["activity.empty"]}</p>
			) : null}
			{batches.current >= 8 && (state.windowTarget !== undefined || pages?.at(-1)?.page.nextCursor) ? (
				<output>{activityLabels(locale)["activity.partial"]}</output>
			) : null}
		</section>
	);
}
