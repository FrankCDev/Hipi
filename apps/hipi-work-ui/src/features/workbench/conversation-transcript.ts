import type { Message, Snapshot } from "@hipi/work-runtime/contracts";

export const STREAM_ROW_KEY = "partial-output";
export const TRANSCRIPT_GAP = 12;
// These are individual semantic message blocks, not reference turn rows. Keep
// five blocks of overscan until realistic mixed-turn browser evidence says less.
export const TRANSCRIPT_OVERSCAN = 5;
export type TranscriptRow =
	| { key: string; kind: "user-message" | "assistant-message"; message: Message }
	| { key: string; kind: "assistant-stream"; message?: never };

/** Retain unchanged row identities without retaining deleted history or text. */
export function projectTranscript(
	snapshot: Snapshot | undefined,
	previous: readonly TranscriptRow[] = [],
): TranscriptRow[] {
	const retained = new Map(previous.map((row) => [row.key, row]));
	const streamKey = (id: string) => `stream:${JSON.stringify([snapshot?.workspaceId, snapshot?.conversationId, id])}`;
	const rows: TranscriptRow[] = (snapshot?.messages ?? []).map((message) => {
		const key = message.streamId ? streamKey(message.streamId) : `message:${message.id}`;
		const existing = retained.get(key);
		return existing?.message === message
			? existing
			: { key, kind: message.role === "user" ? "user-message" : "assistant-message", message };
	});
	// Only an explicit observer-local identity establishes stream/final continuity.
	// Older history and unprovable transitions keep distinct safe fallback keys.
	if (snapshot?.partial || snapshot?.running) {
		const key = snapshot.partialId ? streamKey(snapshot.partialId) : STREAM_ROW_KEY;
		rows.push(retained.get(key) ?? { key, kind: "assistant-stream" });
	}
	return rows;
}

export function transcriptEstimate(row: TranscriptRow | undefined): number {
	return row?.kind === "user-message" ? 128 : 144;
}
