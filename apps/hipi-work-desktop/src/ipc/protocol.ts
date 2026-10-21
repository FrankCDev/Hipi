import {
	AppError,
	LIMITS,
	PROTOCOL_VERSION,
	parseObservationScope,
	parseRequest,
	type Request,
	type Scope,
} from "@hipi/work-runtime/contracts";

export const CHANNEL = `hipi-work:v${PROTOCOL_VERSION}`;
export const MAX_ACTIVE = 16;
export const WAIT_MS = 10000;
export type ObservationInput = { scope: Scope; expectedStoreId: string };
export type HostCommand =
	| { generation: string; id: string; kind: "call"; request: Request }
	| { generation: string; id: string; kind: "observe"; input: ObservationInput }
	| { generation: string; id: string; kind: "cancel" | "ack" }
	| { generation: string; kind: "shutdown" };
export function record(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("INVALID_REQUEST");
	return raw as Record<string, unknown>;
}
export function identifier(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw)) throw new AppError("INVALID_REQUEST");
	return raw;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new AppError("INVALID_REQUEST");
}
export function decode(raw: unknown): Record<string, unknown> {
	if (
		typeof raw !== "string" ||
		raw.length > LIMITS.frameBytes ||
		new TextEncoder().encode(raw).byteLength > LIMITS.frameBytes
	)
		throw new AppError("INVALID_REQUEST");
	return record(JSON.parse(raw));
}
export function encode(raw: unknown): string {
	const value = JSON.stringify(raw);
	if (new TextEncoder().encode(value).byteLength > LIMITS.frameBytes) throw new AppError("CAPACITY_EXCEEDED");
	return value;
}
export function observation(raw: unknown): ObservationInput {
	const value = record(raw);
	exact(value, ["scope", "expectedStoreId"]);
	return { scope: parseObservationScope(value.scope), expectedStoreId: identifier(value.expectedStoreId) };
}
export function command(raw: unknown): HostCommand {
	const value = decode(raw);
	const generation = identifier(value.generation);
	if (value.kind === "shutdown") {
		exact(value, ["generation", "kind"]);
		return { generation, kind: "shutdown" };
	}
	const id = identifier(value.id);
	if (value.kind === "call") {
		exact(value, ["generation", "id", "kind", "request"]);
		return { generation, id, kind: "call", request: parseRequest(value.request) };
	}
	if (value.kind === "observe") {
		exact(value, ["generation", "id", "kind", "input"]);
		return { generation, id, kind: "observe", input: observation(value.input) };
	}
	if (value.kind === "ack" || value.kind === "cancel") {
		exact(value, ["generation", "id", "kind"]);
		return { generation, id, kind: value.kind };
	}
	throw new AppError("INVALID_REQUEST");
}
