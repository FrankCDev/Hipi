import type { RunInputRefs, Snapshot } from "@hipi/work-runtime/contracts";
import type { TranscriptRow } from "../transcript.ts";
import type { ConversationRow, TurnRow } from "./contracts.ts";
/** Identity is independent of page coverage. Unknown chronological barriers are never crossed. */
export function projectAuthoritativeTurns(
	rows: readonly TranscriptRow[],
	snapshot: Snapshot | undefined,
): ConversationRow[] {
	if (!snapshot) return [...rows];
	const refs = new Map<string, RunInputRefs | undefined>();
	for (const row of rows) if (row.message?.runId) refs.set(row.message.runId, undefined);
	const invalid = new Set<string>(),
		observed = new Set<string>();
	for (const result of snapshot.runResults?.items ?? []) {
		if (observed.has(result.id)) {
			invalid.add(result.id);
			refs.delete(result.id);
			continue;
		}
		observed.add(result.id);
		refs.set(result.id, result.inputRefs);
	}
	const current = snapshot.execution?.run;
	if (current) {
		if (observed.has(current.id)) {
			invalid.add(current.id);
			refs.delete(current.id);
		} else refs.set(current.id, current.inputRefs);
	}
	const claimed = new Map<string, string>();
	for (const [run, inputs] of refs)
		for (const id of inputs?.entryIds ?? []) {
			const other = claimed.get(id);
			if (other && other !== run) {
				invalid.add(other);
				invalid.add(run);
			}
			claimed.set(id, run);
		}
	const groups = new Map<number, TurnRow>(),
		consumed = new Set<number>();
	for (const [runId, inputs] of refs) {
		if (invalid.has(runId)) continue;
		const ids = new Set(inputs?.entryIds.map((id) => `${id}_0`) ?? []),
			found = new Set<string>();
		const members: { row: TranscriptRow; index: number }[] = [];
		let conflict = false;
		rows.forEach((row, index) => {
			if (!row.message) {
				if (row.kind === "assistant-stream" && current?.id === runId && snapshot.running) members.push({ row, index });
				return;
			}
			const input = ids.has(row.message.id);
			if (input) {
				if (row.message.role !== "user" || (row.message.runId && row.message.runId !== runId)) conflict = true;
				found.add(row.message.id);
			}
			if (input || row.message.runId === runId) members.push({ row, index });
		});
		const first = members[0];
		if (
			conflict ||
			!first ||
			members.some(
				(member, index) =>
					consumed.has(member.index) || (index > 0 && member.index !== (members[index - 1]?.index ?? -2) + 1),
			)
		)
			continue;
		groups.set(first.index, {
			kind: "turn",
			key: `turn:${runId}`,
			runId,
			inputCoverage:
				inputs === undefined ? "unknown" : !inputs.omitted && found.size === inputs.total ? "complete" : "partial",
			children: members.map((member) => member.row),
		});
		for (const member of members) consumed.add(member.index);
	}
	return rows.flatMap<ConversationRow>((row, index) => {
		const group = groups.get(index);
		return group ? [group] : consumed.has(index) ? [] : [row];
	});
}
