import { type AppClient, AppError, parseResult } from "@hipi/work-runtime/contracts";

export type ConnectionFailure =
	| "invalid"
	| "authError"
	| "networkError"
	| "protocolError"
	| "runtimeError"
	| "inUse"
	| "unsupportedBrowser";
export class StoreInUseError extends Error {}
export class UnsupportedBrowserError extends Error {}
const leaseIdentity = Symbol("verifiedStoreLease");
export type StoreLease = {
	readonly storeId: string;
	readonly active: boolean;
	readonly [leaseIdentity]: true;
	release(): void;
};

/** One browser tab owns editing for a store, including drafts and receipt reconciliation. */
export function acquireStoreLease(storeId: string, locks: LockManager | undefined): Promise<StoreLease> {
	if (!locks) return Promise.reject(new UnsupportedBrowserError("Browser Web Locks are required"));
	return new Promise((resolve, reject) => {
		void locks
			.request(`hipi.work.session.${storeId}`, { ifAvailable: true }, async (lock) => {
				if (!lock) throw new StoreInUseError("Store is open in another tab");
				await new Promise<void>((release) => {
					let active = true;
					resolve({
						storeId,
						[leaseIdentity]: true,
						get active() {
							return active;
						},
						release() {
							active = false;
							release();
						},
					});
				});
			})
			.catch(reject);
	});
}

/** Only a validated handshake can select the local restoration namespace. */
export async function verifyConnection(client: AppClient, signal: AbortSignal): Promise<string> {
	const result = parseResult("handshake", await client.call("handshake", {}, signal));
	if (signal.aborted) throw new DOMException("Connection check cancelled", "AbortError");
	return result.storeId;
}

export function connectionFailure(error: unknown): ConnectionFailure {
	if (error instanceof StoreInUseError) return "inUse";
	if (error instanceof UnsupportedBrowserError) return "unsupportedBrowser";
	if (error instanceof AppError) {
		if (error.code === "UNAUTHORIZED") return "authError";
		if (error.code === "INVALID_REQUEST") return "protocolError";
		return "runtimeError";
	}
	if (error instanceof SyntaxError) return "protocolError";
	return "networkError";
}
