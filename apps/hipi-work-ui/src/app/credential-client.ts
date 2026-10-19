import { AppError, type CredentialState, parseError } from "@hipi/work-runtime/contracts";

export type CredentialRequest =
	| { operation: "status" | "remove"; provider: "openai" }
	| { operation: "set"; provider: "openai"; secret: string };
export interface CredentialBridge {
	request(input: unknown): Promise<unknown>;
}
export interface CredentialClient {
	readonly storage: "system" | "memory";
	request(input: CredentialRequest): Promise<CredentialState>;
}
declare global {
	interface Window {
		hipiWorkCredentials?: CredentialBridge;
	}
}
/** No credentials enter the general RPC or query cache. Never retain requests for retries. */
export function createCredentialClient(
	bridge: CredentialBridge,
	storage: "system" | "memory" = "system",
): CredentialClient {
	return {
		storage,
		async request(input) {
			if (
				input.provider !== "openai" ||
				!["status", "set", "remove"].includes(input.operation) ||
				Object.keys(input).some(
					(key) => !["operation", "provider", ...(input.operation === "set" ? ["secret"] : [])].includes(key),
				)
			)
				throw new AppError("INVALID_REQUEST");
			if (input.operation === "set" && !/^[\x21-\x7e]{1,4096}$/.test(input.secret))
				throw new AppError("INVALID_REQUEST");
			let response: unknown;
			try {
				response = await new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(() => reject(new AppError("CLOSED")), 10000);
					Promise.resolve()
						.then(() => bridge.request({ version: 1, ...input }))
						.then(
							(value) => {
								clearTimeout(timer);
								resolve(value);
							},
							() => {
								clearTimeout(timer);
								reject(new AppError("CLOSED"));
							},
						);
				});
			} catch {
				throw new AppError("CLOSED");
			}
			if (!response || typeof response !== "object" || Array.isArray(response)) throw new AppError("INVALID_REQUEST");
			const value = response as Record<string, unknown>;
			if (value.ok === false && Object.keys(value).every((key) => key === "ok" || key === "error"))
				throw new AppError(parseError(value.error));
			if (
				value.ok !== true ||
				Object.keys(value).some((key) => key !== "ok" && key !== "state") ||
				!["configured", "missing", "locked", "unavailable"].includes(String(value.state))
			)
				throw new AppError("INVALID_REQUEST");
			return value.state as CredentialState;
		},
	};
}
