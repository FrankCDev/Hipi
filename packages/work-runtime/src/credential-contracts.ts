import { AppError, type CredentialState, type ErrorCode, parseError } from "./contracts.ts";

/** Separate management capability; never part of AppClient or persisted request receipts. */
export const CREDENTIAL_BODY_BYTES = 16 * 1024;
export const MAX_CREDENTIAL_PROVIDERS = 32;
export type CredentialProvider = "openai" | `custom_${string}`;
export type CredentialRequest =
	| { version: 1; operation: "status" | "remove"; provider: CredentialProvider }
	| { version: 1; operation: "set"; provider: CredentialProvider; secret: string };
export type CredentialResponse = { ok: true; state: CredentialState } | { ok: false; error: ErrorCode };
export interface CredentialManagement {
	execute(request: CredentialRequest): Promise<CredentialResponse>;
}
export function credentialProvider(value: unknown): CredentialProvider {
	if (value === "openai") return value;
	if (typeof value !== "string" || !/^custom_[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
		throw new AppError("INVALID_REQUEST");
	return value as CredentialProvider;
}
export function credentialSecret(value: unknown): string {
	// Keys must be bounded printable ASCII without whitespace, CR/LF, or NUL.
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
