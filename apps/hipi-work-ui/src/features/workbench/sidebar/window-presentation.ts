import type { Scope, SidebarConversation } from "@hipi/work-runtime/contracts";
import { type RecentWindow, scopeKey, windowItems } from "./window-query.ts";
export type WindowSlice = { start: number; end: number };
export const initialSlice = (length: number, complete = false): WindowSlice => ({
	start: 0,
	end: complete && length === 11 ? 11 : Math.min(10, length),
});
export function advanceSlice(
	slice: WindowSlice,
	length: number,
	direction: "next" | "previous",
	complete = false,
): WindowSlice {
	return direction === "next"
		? { start: slice.start, end: complete && length - slice.end === 6 ? length : Math.min(length, slice.end + 5) }
		: { start: Math.max(0, slice.start - 5), end: slice.end };
}
export function reconcileWindowSlice(
	previous: RecentWindow | undefined,
	slice: WindowSlice,
	next: RecentWindow,
): WindowSlice {
	if (previous && next.refreshPaused && next.revision === previous.revision) return slice;
	const rows = windowItems(next);
	if (!previous) return initialSlice(rows.length, !next.pages.at(-1)?.nextCursor);
	const shown = windowItems(previous).slice(slice.start, slice.end);
	const keys = new Set(shown.map((row) => scopeKey(row.conversation)));
	const overlap = rows.flatMap((row, index) => (keys.has(scopeKey(row.conversation)) ? [index] : []));
	if (!overlap.length)
		return next.action === "refresh"
			? { start: 0, end: Math.min(rows.length, Math.max(10, slice.end - slice.start)) }
			: initialSlice(rows.length);
	const first = overlap[0] ?? 0;
	const last = (overlap.at(-1) ?? first) + 1;
	return next.action === "previous"
		? { start: Math.max(0, first - 5), end: last }
		: next.action === "next"
			? advanceSlice({ start: first, end: last }, rows.length, "next", !next.pages.at(-1)?.nextCursor)
			: { start: slice.start === 0 && !previous.pages[0]?.previousCursor ? 0 : first, end: last };
}
/** Retained proofs are already canonically ordered by the runtime, including private tie breakers. */
export function presentedWindow(
	value: RecentWindow,
	slice: WindowSlice,
	focused?: Scope,
	selected?: Scope,
): { before: SidebarConversation[]; rows: SidebarConversation[]; after: SidebarConversation[] } {
	const all = windowItems(value);
	const rows = all.slice(slice.start, slice.end);
	const visible = new Set(rows.map((row) => scopeKey(row.conversation)));
	const requested = new Set([focused, selected].filter((scope): scope is Scope => !!scope).map(scopeKey));
	const before: SidebarConversation[] = [];
	const after: SidebarConversation[] = [];
	// Proofs inside the loaded window use its exact ordinal, not their relation to the newest page alone.
	for (const proof of value.retained.eligible) {
		const key = scopeKey(proof.row.conversation);
		if (!requested.has(key) || visible.has(key) || all.some((row) => scopeKey(row.conversation) === key)) continue;
		if (proof.placement === "before") before.push(proof.row);
		else after.push(proof.row);
	}
	return {
		before: [...before, ...all.slice(0, slice.start).filter((row) => requested.has(scopeKey(row.conversation)))],
		rows,
		after: [...all.slice(slice.end).filter((row) => requested.has(scopeKey(row.conversation))), ...after],
	};
}
