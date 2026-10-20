import { AppError, type CredentialState } from "./contracts.ts";
import {
	type CredentialManagement,
	type CredentialProvider,
	credentialProvider,
	MAX_CREDENTIAL_PROVIDERS,
	parseCredentialRequest,
} from "./credential-contracts.ts";
import type { CredentialPort } from "./model-provider.ts";

/** Explicit development-host storage. No ambient auth, files, or persistence; restart clears it. */
export function createMemoryCredentials(): { port: CredentialPort; management: CredentialManagement; clear(): void } {
	const secrets = new Map<CredentialProvider, string>();
	const status = async (provider: string): Promise<CredentialState> =>
		secrets.has(credentialProvider(provider)) ? "configured" : "missing";
	return {
		port: { status, get: async (provider) => secrets.get(credentialProvider(provider)) },
		management: {
			async execute(raw) {
				const request = parseCredentialRequest(raw);
				if (request.operation === "set") {
					if (!secrets.has(request.provider) && secrets.size >= MAX_CREDENTIAL_PROVIDERS)
						throw new AppError("CAPACITY_EXCEEDED");
					secrets.set(request.provider, request.secret);
				}
				if (request.operation === "remove") secrets.delete(request.provider);
				return { ok: true, state: await status(request.provider) };
			},
		},
		clear() {
			secrets.clear();
		},
	};
}
