import { useEffect, useRef } from "react";
import { selectionIntersects } from "../workbench/conversation/message-projection.ts";
import type { ActivitySession, ActivityState } from "./activity-session.ts";
import { activityLabels } from "./labels.ts";

/** A demand sentinel, not a transport control. Reads stop with the mounted view. */
export function ActivityContinuation({
	session,
	state,
	enabled,
	locale,
}: {
	session: ActivitySession;
	state: ActivityState;
	enabled: boolean;
	locale: string;
}) {
	const root = useRef<HTMLOutputElement>(null);
	const batches = useRef(0);
	const cursor = state.page?.nextCursor;
	useEffect(() => {
		const element = root.current;
		if (!element || !enabled || state.busy || state.failed || !cursor || (state.page?.items.length ?? 0) >= 16) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let visible = false;
		const load = () => {
			if (timer || !visible) return;
			if (
				document.visibilityState === "hidden" ||
				selectionIntersects(element.closest(".conversation-panel") ?? element, document.getSelection())
			)
				return;
			if (batches.current >= 8) return;
			batches.current++;
			timer = setTimeout(() => void session.inlinePage(cursor), 50);
		};
		const observer = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) load();
			else {
				clearTimeout(timer);
				timer = undefined;
			}
		});
		observer.observe(element);
		const resume = () => {
			batches.current = 0;
			const box = element.getBoundingClientRect();
			if (box.bottom >= 0 && box.top <= innerHeight) load();
		};
		element.closest(".inline-activity-details")?.addEventListener("scroll", resume, { passive: true });
		element.closest(".inline-activity-details")?.addEventListener("wheel", resume, { passive: true });
		element.closest(".inline-activity-details")?.addEventListener("keydown", resume);
		document.addEventListener("selectionchange", load);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
			document.removeEventListener("selectionchange", load);
			element.closest(".inline-activity-details")?.removeEventListener("scroll", resume);
			element.closest(".inline-activity-details")?.removeEventListener("wheel", resume);
			element.closest(".inline-activity-details")?.removeEventListener("keydown", resume);
		};
	}, [session, enabled, state.busy, state.failed, state.page?.items.length, cursor]);
	return cursor ? (
		<output ref={root} className="activity-continuation">
			{!state.busy && !state.failed && ((state.page?.items.length ?? 0) >= 16 || batches.current >= 8)
				? activityLabels(locale)["activity.partial"]
				: null}
		</output>
	) : null;
}
