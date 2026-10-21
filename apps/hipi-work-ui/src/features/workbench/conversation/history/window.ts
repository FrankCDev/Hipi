import { LIMITS, type Message } from "@hipi/work-runtime/contracts";

export const HISTORY_CAPACITY = { messages: 2048, textUnits: 4 * 1024 * 1024, pages: 2048 } as const;
export const HISTORY_PROXIMITY = 800;
export type HistoryDirection = "older" | "newer";
export type HistoryViewport = {
	olderDistance: number;
	newerDistance: number;
	pinnedIds: ReadonlySet<string>;
	paused: boolean;
};

/** Brent's constant-space cycle detector supplements the short retry checkpoint
 * set, so a cycle longer than that bounded set still cannot drain forever. */
export class HistoryCursorProgress {
	private checkpoint: string | undefined;
	private power = 1;
	private distance = 0;
	valid(cursor: string, next: string | null) {
		return next === null || (next !== cursor && next !== this.checkpoint);
	}
	advance(cursor: string, next: string | null): boolean {
		this.checkpoint ??= cursor;
		if (next === null) return true;
		if (next === cursor || next === this.checkpoint) return false;
		this.distance++;
		if (this.distance === this.power) {
			this.checkpoint = next;
			this.power = Math.min(Number.MAX_SAFE_INTEGER, this.power * 2);
			this.distance = 0;
		}
		return true;
	}
}

// Latest observation, a captured replay fence, predecessor/current/next page
// have explicit headroom (search uses its seed instead). These are preview/source
// bounds, not heap limits; row arrays share message objects rather than copying text.
const RESERVED_PAGES = 5;
export function fitsHistory(messages: readonly Message[]): boolean {
	return (
		messages.length <= HISTORY_CAPACITY.messages - RESERVED_PAGES * LIMITS.historyMessages &&
		messages.reduce((sum, message) => sum + message.text.length, 0) <=
			HISTORY_CAPACITY.textUnits - RESERVED_PAGES * LIMITS.historyMessages * LIMITS.messagePreview
	);
}

/** Contiguous eviction only, from the edge opposite demand. Never cross a lease. */
export function fitHistoryWindow(
	messages: Message[],
	direction: HistoryDirection,
	viewport: HistoryViewport | null,
): Message[] | undefined {
	if (fitsHistory(messages)) return messages;
	if (!viewport || viewport.paused) return undefined;
	let first = 0;
	let last = messages.length;
	let units = messages.reduce((sum, message) => sum + message.text.length, 0);
	while (
		last - first > HISTORY_CAPACITY.messages - RESERVED_PAGES * LIMITS.historyMessages ||
		units > HISTORY_CAPACITY.textUnits - RESERVED_PAGES * LIMITS.historyMessages * LIMITS.messagePreview
	) {
		const index = direction === "older" ? last - 1 : first;
		const message = messages[index];
		if (!message || viewport.pinnedIds.has(message.id)) return undefined;
		units -= message.text.length;
		if (direction === "older") last--;
		else first++;
	}
	return messages.slice(first, last);
}
