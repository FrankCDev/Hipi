import { type CheckpointInfo, type CommitPublication, defineDocFamily } from "@earendil-works/pi-durable";

/** Original submission time only. Execution clocks remain owned by PI task records. */
export const ConversationActivityDoc = defineDocFamily<{ latestAcceptedAt: number | null }, null>({
	kind: "hipi.conversation-activity",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({ latestAcceptedAt: null }),
	checkpointWhen: (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= 31,
});

/** Invalidation only: no clock reads, Session calls, asynchronous work or retained publications. */
export function changesNavigation(publication: CommitPublication, started: Set<number>): boolean {
	let changed = false;
	for (const change of publication.changes) {
		if (change.type === "document" || change.type === "document.copy") {
			changed ||=
				change.record.kind === "hipi.workspace-directory" ||
				change.record.kind === "hipi.conversation-metadata" ||
				change.record.kind === "hipi.conversation-activity";
		}
		if (change.type === "entry")
			changed ||=
				change.value.model?.some((message) => message.role === "user" || message.role === "assistant") ?? false;
		if (change.type !== "task" || change.value.kind !== "pi.generation") continue;
		const task = change.value;
		if (task.state.status === "terminal") {
			started.delete(task.id);
			changed ||= task.endedAt !== undefined;
		} else if (task.state.status === "running" && task.startedAt !== undefined && !started.has(task.id)) {
			// Bound retained identities. Overflow only causes extra invalidation, never dropped activity.
			if (started.size < 256) started.add(task.id);
			changed = true;
		}
	}
	return changed;
}
