import type { CSSProperties } from "react";

const paths = {
	plus: "M12 5v14M5 12h14",
	chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z",
	folder: "M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11H3Z",
	panel: "M3 4h18v16H3ZM9 4v16",
	sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
	arrowUp: "M12 19V5m-6 6 6-6 6 6",
	arrowDown: "M12 5v14m-6-6 6 6 6-6",
	info: "M12 11v6m0-10v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
	refresh: "M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-1L20 8M4 16l1.5 2a8 8 0 0 0 13-1",
	chevron: "m9 5 7 7-7 7",
	logout: "M9 4H4v16h5m5-13 5 5-5 5M8 12h11",
	search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
	check: "m5 12 4 4L19 6",
} as const;

/** Small, owned stroke icon vocabulary. Decorative by default; name the parent action. */
export function Icon({ name, size = 18, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
		>
			<path d={paths[name]} />
		</svg>
	);
}
