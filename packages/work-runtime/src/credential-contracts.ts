import { AppError, type CredentialState, type ErrorCode, parseError } from "./contracts.ts";

/** Separate management capability; never part of AppClient or persisted request receipts. */
export const CREDENTIAL_BODY_BYTES = 16 * 1024;
export type CredentialRequest =
	| { version: 1; operation: "status" | "remove"; provider: "openai" }
	| { version: 1; operation: "set"; provider: "openai"; secret: string };
export type CredentialResponse = { ok: true; state: CredentialState } | { ok: false; error: ErrorCode };
export interface CredentialManagement {
	execute(request: CredentialRequest): Promise<CredentialResponse>;
}
export function credentialProvider(value: unknown): "openai" {
	if (value !== "openai") throw new AppError("INVALID_REQUEST");
	return value;
}
export function credentialSecret(value: unknown): string {
	// Official API keys are printable ASCII. This stricter bound also excludes CR/LF/NUL.
	if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value)) throw new AppError("INVALID_REQUEST");
	return value;
}
export function credentialState(value: unknown): CredentialState {
	if (value !== "configured" && value !== "missing" && value !== "locked" && value !== "unavailable")
		throw new AppError("INVALID_REQUEST");
	return value;
}
export function parseCredentialRequest(raw: unknown): CredentialRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("INVALID_REQUEST");
	const value = raw as Record<string, unknown>;
	if (value.version !== 1) throw new AppError("INVALID_REQUEST");
	const provider = credentialProvider(value.provider);
	const allowed = ["version", "operation", "provider", ...(value.operation === "set" ? ["secret"] : [])];
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AppError("INVALID_REQUEST");
	if (value.operation === "set")
		return { version: 1, operation: "set", provider, secret: credentialSecret(value.secret) };
	if (value.operation !== "status" && value.operation !== "remove") throw new AppError("INVALID_REQUEST");
	return { version: 1, operation: value.operation, provider };
}
export function parseCredentialResponse(raw: unknown): CredentialResponse {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("INVALID_REQUEST");
	const value = raw as Record<string, unknown>;
	if (value.ok === true && Object.keys(value).every((key) => key === "ok" || key === "state"))
		return { ok: true, state: credentialState(value.state) };
	if (value.ok === false && Object.keys(value).every((key) => key === "ok" || key === "error"))
		return { ok: false, error: parseError(value.error) };
	throw new AppError("INVALID_REQUEST");
}
