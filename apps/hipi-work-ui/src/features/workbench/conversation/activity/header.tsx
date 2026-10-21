import { runWallElapsedMs } from "@hipi/work-runtime/contracts";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { usePreferences } from "../../../../app/preferences.tsx";
import type { RunActivity } from "./contracts.ts";
import "./header.css";

/** One mounted display clock. It never changes runtime state or invents missing timestamps. */
export function RunActivityHeader({ activity, onToggle }: { activity: RunActivity; onToggle: () => void }) {
	const { locale } = usePreferences();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!activity.running || activity.admittedAtMs === undefined) return;
		let timer: ReturnType<typeof setInterval> | undefined;
		const update = () => {
			clearInterval(timer);
			timer = undefined;
			if (document.visibilityState === "hidden") return;
			setNow(Date.now());
			timer = setInterval(() => setNow(Date.now()), 1000);
		};
		update();
		document.addEventListener("visibilitychange", update);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
		};
	}, [activity.running, activity.admittedAtMs]);
	const elapsed = activity.result
		? runWallElapsedMs(activity.result)
		: activity.running && activity.admittedAtMs !== undefined
			? runWallElapsedMs({ admittedAtMs: activity.admittedAtMs, settledAtMs: now })
			: undefined;
	const zh = locale.startsWith("zh");
	// Reference collapsed duration fallback calls qJu(duration) without a locale
	// (default en); the live worked-for status calls it with the UI locale.
	// Our settled wall duration is the former, not a fabricated workedForItem.
	const time = elapsed === undefined ? undefined : formatRunElapsed(elapsed, activity.result ? "en" : locale);
	const label =
		activity.running && elapsed !== undefined && elapsed < 1000
			? zh
				? "正在处理"
				: "Working"
			: time !== undefined
				? activity.running
					? zh
						? `已用时 ${time}`
						: `Working for ${time}`
					: zh
						? `用时 ${time}`
						: `Worked for ${time}`
				: activity.members.length > 0
					? zh
						? `前面的 ${activity.members.length} 条消息`
						: `${activity.members.length} previous messages`
					: activity.running
						? zh
							? "活动"
							: "Activity"
						: undefined;
	if (!label || (!activity.running && activity.members.length === 0)) return null;
	const description =
		time === undefined ? label : zh ? `${label}，总用时包含等待时间` : `${label}; elapsed wall time includes waits`;

	return (
		<div
			className="run-activity-header"
			data-preserve-turn-viewport=""
			data-run-id={activity.id}
			data-run-collapsible={activity.members.length > 0}
		>
			{activity.members.length > 0 ? (
				<button
					type="button"
					className="run-activity-toggle inline-activity-toggle"
					aria-expanded={activity.expanded}
					aria-label={description}
					onClick={onToggle}
				>
					<span>{label}</span>
					<ChevronRight aria-hidden="true" />
				</button>
			) : (
				<span role="timer" aria-label={description}>
					{label}
				</span>
			)}
		</div>
	);
}

/** Reference narrow-unit decomposition, with zero intermediate units omitted. */
export function formatRunElapsed(elapsed: number, locale: string): string {
	const total = Math.floor(elapsed / 1000);
	const values = [
		["day", Math.floor(total / 86400)],
		["hour", Math.floor(total / 3600) % 24],
		["minute", Math.floor(total / 60) % 60],
		["second", total % 60],
	] as const;
	return values
		.filter(([, value]) => value > 0 || total === 0)
		.map(([unit, value]) => {
			if (total === 0 && unit !== "second") return "";
			const formatter = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" });
			return locale.toLowerCase().split("-")[0] === "hu"
				? formatter
						.formatToParts(value)
						.filter((part) => part.type !== "literal")
						.map((part) => part.value)
						.join("")
				: formatter.format(value);
		})
		.filter(Boolean)
		.join(" ");
}
