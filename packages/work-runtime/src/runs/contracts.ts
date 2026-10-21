/** Observed facts only: never proof of complete run membership or active compute time. */
export const RUN_LIMITS = { results: 64, bytes: 32768, answerLookups: 32 } as const;
export type RunAdmission = { id: string; admittedAtMs?: number };
export type RunResultObservation = {
	id: string;
	terminalEntryId: string;
	/** Inclusive wall-clock samples, including waits and process downtime. */
	admittedAtMs: number;
	settledAtMs: number;
	terminalCause: "response" | "tool-terminate" | "tool-handoff" | "unanswered";
	settlement:
		| { status: "done" }
		| { status: "unanswered"; reason?: "aborted" | "reset" | "faulted" | "model_error" | "no_model" };
	/** Exact fork-visible, single-model, non-tool assistant response. Not an early phase signal. */
	responseMessageId?: string;
};
/** Different terminals for the same id are conflict evidence; consumers must not select a winner. */
export type RunResults = { items: RunResultObservation[]; omitted: boolean };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error("Invalid run metadata");
	return value as Record<string, unknown>;
}
export function parseRunIdentifier(value: unknown): string {
	if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error("Invalid run identifier");
	return value;
}
export function isRunTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function parseRunAdmission(value: unknown): RunAdmission {
	const p = object(value, ["id", "admittedAtMs"]);
	if (p.admittedAtMs !== undefined && !isRunTimestamp(p.admittedAtMs)) throw new Error("Invalid run timestamp");
	return { id: parseRunIdentifier(p.id), ...(p.admittedAtMs === undefined ? {} : { admittedAtMs: p.admittedAtMs }) };
}
export function parseRunResult(value: unknown): RunResultObservation {
	const p = object(value, [
		"id",
		"terminalEntryId",
		"admittedAtMs",
		"settledAtMs",
		"terminalCause",
		"settlement",
		"responseMessageId",
	]);
	const id = parseRunIdentifier(p.id),
		terminalEntryId = parseRunIdentifier(p.terminalEntryId);
	if (!isRunTimestamp(p.admittedAtMs) || !isRunTimestamp(p.settledAtMs)) throw new Error("Invalid run timestamps");
	if (
		p.terminalCause !== "response" &&
		p.terminalCause !== "tool-terminate" &&
		p.terminalCause !== "tool-handoff" &&
		p.terminalCause !== "unanswered"
	)
		throw new Error("Invalid run cause");
	const s = object(p.settlement, ["status", "reason"]);
	let settlement: RunResultObservation["settlement"];
	if (s.status === "done" && p.terminalCause !== "unanswered" && s.reason === undefined)
		settlement = { status: "done" };
	else if (s.status === "unanswered" && p.terminalCause === "unanswered") {
		if (
			s.reason !== undefined &&
			s.reason !== "aborted" &&
			s.reason !== "reset" &&
			s.reason !== "faulted" &&
			s.reason !== "model_error" &&
			s.reason !== "no_model"
		)
			throw new Error("Invalid run reason");
		settlement = { status: "unanswered", ...(s.reason === undefined ? {} : { reason: s.reason }) };
	} else throw new Error("Inconsistent run settlement");
	let responseMessageId: string | undefined;
	if (p.responseMessageId !== undefined) {
		if (
			p.terminalCause !== "response" ||
			settlement.status !== "done" ||
			typeof p.responseMessageId !== "string" ||
			!p.responseMessageId.endsWith("_0")
		)
			throw new Error("Invalid run response");
		const answer = parseRunIdentifier(p.responseMessageId.slice(0, -2));
		if (Number(answer) >= Number(terminalEntryId)) throw new Error("Invalid run response order");
		responseMessageId = p.responseMessageId;
	}
	return {
		id,
		terminalEntryId,
		admittedAtMs: p.admittedAtMs,
		settledAtMs: p.settledAtMs,
		terminalCause: p.terminalCause,
		settlement,
		...(responseMessageId === undefined ? {} : { responseMessageId }),
	};
}
export function runResultsBytes(value: RunResults): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function parseRunResults(value: unknown): RunResults {
	const p = object(value, ["items", "omitted"]);
	if (!Array.isArray(p.items) || p.items.length > RUN_LIMITS.results || typeof p.omitted !== "boolean")
		throw new Error("Invalid run coverage");
	const result = { items: Array.from(p.items, parseRunResult), omitted: p.omitted };
	if (
		new Set(result.items.map((item) => item.terminalEntryId)).size !== result.items.length ||
		runResultsBytes(result) > RUN_LIMITS.bytes
	)
		throw new Error("Invalid run result bounds");
	return result;
}
/** Inverted clocks are unknown, not a fabricated zero. Callers must also exclude conflicting observations. */
export function runWallElapsedMs(
	result: Pick<RunResultObservation, "admittedAtMs" | "settledAtMs">,
): number | undefined {
	return isRunTimestamp(result.admittedAtMs) &&
		isRunTimestamp(result.settledAtMs) &&
		result.settledAtMs >= result.admittedAtMs
		? result.settledAtMs - result.admittedAtMs
		: undefined;
}
