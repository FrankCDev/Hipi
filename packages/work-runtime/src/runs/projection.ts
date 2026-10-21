import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import {
	isRunTimestamp,
	parseRunIdentifier,
	parseRunResult,
	type RunAdmission,
	type RunResultObservation,
} from "./contracts.ts";

/** Only supported immutable model records carry public membership, never arbitrary host kinds. */
export function projectMessageRunId(entry: EntryRecord): string | undefined {
	if (typeof entry.runId !== "number") return undefined;
	if (entry.head || entry.model?.length !== 1 || (entry.kind !== "pi.assistant" && entry.kind !== "pi.user"))
		return undefined;
	if (entry.model[0]?.role !== (entry.kind === "pi.assistant" ? "assistant" : "user")) return undefined;
	try {
		return parseRunIdentifier(String(entry.runId));
	} catch {
		return undefined;
	}
}
export function projectRunAdmission(live: LiveState): RunAdmission | undefined {
	const group = live.run?.group;
	if (!group || typeof group.id !== "number") return undefined;
	try {
		return {
			id: parseRunIdentifier(String(group.id)),
			...(isRunTimestamp(group.admittedAt) ? { admittedAtMs: group.admittedAt } : {}),
		};
	} catch {
		return undefined;
	}
}
/** The caller supplies only entries returned by the bounded fork-aware history read. */
export function projectRunResult(entry: EntryRecord): { result: RunResultObservation; answerId?: number } | undefined {
	if (entry.kind !== "pi.run-result" || entry.head || entry.model !== undefined) return undefined;
	const data = entry.data;
	if (
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		typeof data.runId !== "number" ||
		data.runId !== entry.runId
	)
		return undefined;
	const settlement = data.settlement;
	if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) return undefined;
	try {
		let answerId: number | undefined;
		if (settlement.status === "done") {
			if (typeof settlement.answer !== "number") return undefined;
			answerId = Number(parseRunIdentifier(String(settlement.answer)));
			if (answerId >= entry.id) return undefined;
		}
		const result = parseRunResult({
			id: String(data.runId),
			terminalEntryId: String(entry.id),
			admittedAtMs: data.admittedAt,
			settledAtMs: data.settledAt,
			terminalCause: data.terminalCause,
			settlement:
				settlement.status === "done"
					? { status: "done" }
					: {
							status: settlement.status,
							...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
						},
		});
		return { result, ...(answerId === undefined ? {} : { answerId }) };
	} catch {
		return undefined;
	}
}
export function responseMessageId(
	terminal: EntryRecord,
	result: RunResultObservation,
	answer: EntryRecord | undefined,
): string | undefined {
	const settlement =
		terminal.data && typeof terminal.data === "object" && !Array.isArray(terminal.data)
			? terminal.data.settlement
			: undefined;
	if (
		result.terminalCause !== "response" ||
		result.settlement.status !== "done" ||
		!answer ||
		!settlement ||
		typeof settlement !== "object" ||
		Array.isArray(settlement) ||
		settlement.status !== "done" ||
		settlement.answer !== answer.id ||
		answer.conversationId !== terminal.conversationId ||
		answer.kind !== "pi.assistant" ||
		projectMessageRunId(answer) !== result.id
	)
		return undefined;
	const message = answer.model?.[0];
	if (
		message?.role !== "assistant" ||
		message.stopReason === "aborted" ||
		message.stopReason === "error" ||
		message.content.some((part) => part.type === "toolCall")
	)
		return undefined;
	return `${answer.id}_0`;
}
