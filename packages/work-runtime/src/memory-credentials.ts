import type { CredentialState } from "./contracts.ts";
import { type CredentialManagement, parseCredentialRequest } from "./credential-contracts.ts";
import type { CredentialPort } from "./model-provider.ts";

/** Explicit development-host storage. No ambient auth, files, or persistence; restart clears it. */
export function createMemoryCredentials(): { port: CredentialPort; management: CredentialManagement; clear(): void } {
	let secret: string | undefined;
	const status = async (provider: string): Promise<CredentialState> =>
		provider !== "openai" ? "unavailable" : secret ? "configured" : "missing";
	return {
		port: { status, get: async (provider) => (provider === "openai" ? secret : undefined) },
		management: {
			async execute(raw) {
				const request = parseCredentialRequest(raw);
				if (request.operation === "set") secret = request.secret;
				if (request.operation === "remove") secret = undefined;
				return { ok: true, state: await status(request.provider) };
			},
		},
		clear() {
			secret = undefined;
		},
	};
}
