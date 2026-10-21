import type { RunResultObservation, Snapshot } from "@hipi/work-runtime/contracts";
import type { TranscriptRow } from "../transcript.ts";

import type { RunActivity } from "./contracts.ts";
import { hasRunResultConflict } from "./results.ts";

/** Group only a contiguous, observed run. Unknown or conflicting facts never hide content. */
export function projectRunActivities(
	rows: readonly TranscriptRow[],
	snapshot: Snapshot | undefined,
	choices: ReadonlyMap<string, boolean>,
	protectedKeys: ReadonlySet<string>,
	active: boolean,
	retainCollapsedMembers = false,
): TranscriptRow[] {
	if (!snapshot) return [...rows];
	const results = new Map<string, RunResultObservation[]>();
	// Partial sidecar coverage does not invalidate individually verified facts.
	// Unknown runs stay unknown; conflicting observations are excluded per run.
	for (const result of snapshot.runResults?.items ?? []) {
		const found = results.get(result.id) ?? [];
		found.push(result);
		results.set(result.id, found);
	}
	const runs = new Map<string, { row: TranscriptRow; index: number }[]>();
	rows.forEach((row, index) => {
		if (row.message?.role !== "assistant" || !row.message.runId) return;
		const found = runs.get(row.message.runId) ?? [];
		found.push({ row, index });
		runs.set(row.message.runId, found);
	});
	const current = snapshot.execution?.run;
	if (snapshot.running && current && !runs.has(current.id)) runs.set(current.id, []);
	const headers = new Map<number, TranscriptRow>();
	const hidden = new Set<string>();
	for (const [id, entries] of runs) {
		if (hasRunResultConflict(snapshot.runResults, id)) continue;
		// A user/unknown/different-run boundary is not evidence of one continuous body.
		if (entries.some((entry, index) => index > 0 && entry.index !== (entries[index - 1]?.index ?? -2) + 1)) continue;
		const observations = results.get(id) ?? [];
		if (observations.length > 1) continue;
		const result = observations[0];
		const isCurrent = snapshot.running && current?.id === id;
		if (isCurrent && (!active || result)) continue;
		if (!result && !isCurrent) continue;
		const finalIndex = result?.responseMessageId
			? entries.findIndex(({ row }) => row.message?.id === result.responseMessageId)
			: -1;
		// Only exact response settlement proves preceding entries are process activity.
		// A tool termination, cancellation, or off-page answer cannot establish that split.
		const candidates =
			!isCurrent && result?.terminalCause === "response" && finalIndex === entries.length - 1 && finalIndex > 0
				? entries.slice(0, finalIndex).map(({ row }) => row.key)
				: [];
		const members = entries.some(
			({ row }) => candidates.includes(row.key) && (row.message?.text || row.message?.toolCalls?.total),
		)
			? candidates
			: [];
		const visibleProcess = entries.some(({ row }) => row.message?.text || row.message?.toolCalls?.total);
		if (isCurrent ? !visibleProcess && !snapshot.execution?.tools.total : members.length === 0) continue;
		const key = `run:${id}`;
		const protectedBody = members.some((member) => protectedKeys.has(member));
		const expanded = members.length === 0 || protectedBody || (choices.get(key) ?? false);
		const activity: RunActivity = {
			id,
			key,
			members,
			expanded,
			running: !!isCurrent && active,
			admittedAtMs: isCurrent ? current?.admittedAtMs : result?.admittedAtMs,
			result,
		};
		const index = entries[0]?.index ?? rows.findIndex((row) => row.kind === "assistant-stream");
		if (index < 0) continue;
		headers.set(index, { key, kind: "run-activity", activity });
		if (!expanded && !retainCollapsedMembers) for (const member of members) hidden.add(member);
	}
	return rows.flatMap((row, index) => {
		const header = headers.get(index);
		return [...(header ? [header] : []), ...(hidden.has(row.key) ? [] : [row])];
	});
}
