import type { TranscriptRow } from "../transcript.ts";
// Ordinary Work Nv caller retains two whole turns beyond the visible range.
export const TURN_OVERSCAN = 2;
export type TurnRow = {
	kind: "turn";
	key: string;
	runId: string;
	/** Admission coverage only, never a claim that all run history is loaded. */
	inputCoverage: "complete" | "partial" | "unknown";
	children: readonly TranscriptRow[];
	message?: never;
};
export type ConversationRow = TranscriptRow | TurnRow;
export function rowMessages(row: ConversationRow): readonly TranscriptRow[] {
	return row.kind === "turn" ? row.children : [row];
}
export function rowContainsKey(row: ConversationRow, key: string): boolean {
	return row.key === key || rowMessages(row).some((child) => child.key === key);
}

/** A stable outer turn can still gain history before the currently read child. */
export function turnMembershipChanged(before: readonly ConversationRow[], after: readonly ConversationRow[]): boolean {
	return (
		before.length !== after.length ||
		after.some((row, index) => {
			const previous = before[index];
			if (!previous || previous.key !== row.key) return true;
			const children = rowMessages(row),
				oldChildren = rowMessages(previous);
			return (
				children.length !== oldChildren.length ||
				children.some((child, childIndex) => child.key !== oldChildren[childIndex]?.key)
			);
		})
	);
}
