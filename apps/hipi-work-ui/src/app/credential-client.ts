import { AppError, type CredentialState } from "@hipi/work-runtime/contracts";
import {
	parseCredentialRequest,
	parseCredentialResponse,
	type CredentialRequest as VersionedCredentialRequest,
} from "@hipi/work-runtime/credentials";

export type CredentialRequest =
	| (Omit<Extract<VersionedCredentialRequest, { operation: "status" | "remove" }>, "version" | "provider"> & {
			provider: string;
	  })
	| (Omit<Extract<VersionedCredentialRequest, { operation: "set" }>, "version" | "provider"> & { provider: string });
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
			const request = parseCredentialRequest({ version: 1, ...input });
			let response: unknown;
			try {
				response = await new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(() => reject(new AppError("CLOSED")), 10000);
					Promise.resolve()
						.then(() => bridge.request(request))
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
			const value = parseCredentialResponse(response);
			if (!value.ok) throw new AppError(value.error);
			return value.state;
		},
	};
}
