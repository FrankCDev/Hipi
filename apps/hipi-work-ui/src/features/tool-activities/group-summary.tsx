import { useEffect, useRef, useState } from "react";

export const GROUP_SUMMARY_DWELL_MS = 1000;
export type GroupSummaryContent = {
	title: string;
	toolName?: string;
	status?: string;
	active: boolean;
	plain?: boolean;
};

/** The reference summary change is a minimum dwell, not a crossfade. The complete
 * summary stays together so a deferred name never acquires another tool's status. */
export function useGroupSummary(value: GroupSummaryContent, key: string, transition: "immediate" | "deferred") {
	const [settled, setSettled] = useState(() => ({ key, value }));
	const changedAt = useRef<number | undefined>(undefined);
	useEffect(() => {
		const now = Date.now();
		changedAt.current ??= now;
		if (key === settled.key) {
			// Keep the held content current without restarting its key's dwell.
			if (
				value.title !== settled.value.title ||
				value.toolName !== settled.value.toolName ||
				value.status !== settled.value.status ||
				value.active !== settled.value.active ||
				value.plain !== settled.value.plain
			)
				setSettled({ key, value });
			return;
		}
		const commit = () => {
			changedAt.current = Date.now();
			setSettled({ key, value });
		};
		const remaining = GROUP_SUMMARY_DWELL_MS - (now - changedAt.current);
		if (transition === "immediate" || remaining <= 0) {
			commit();
			return;
		}
		const timer = setTimeout(commit, remaining);
		return () => clearTimeout(timer);
	}, [key, value, transition, settled.key, settled.value]);
	return transition === "immediate" || settled.key === key ? value : settled.value;
}
