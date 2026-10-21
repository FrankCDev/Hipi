import type { SafeStorage } from "electron";
import type { SafeStoragePort } from "./store.ts";

type NativeStorage = Pick<
	SafeStorage,
	| "isEncryptionAvailable"
	| "getSelectedStorageBackend"
	| "encryptString"
	| "decryptString"
	| "isAsyncEncryptionAvailable"
	| "encryptStringAsync"
	| "decryptStringAsync"
>;
const PROBE = "Hipi Work protected storage capability";
export type CredentialCryptoStage =
	| "async-ready-enter"
	| "async-ready-return"
	| "probe-encrypt-enter"
	| "probe-encrypt-return"
	| "probe-decrypt-enter"
	| "probe-decrypt-return";

/** Darwin keychain IO must not block the main thread. Other platform policies stay unchanged. */
export function createCredentialCrypto(
	storage: NativeStorage,
	platform = process.platform,
	observeStage?: (stage: CredentialCryptoStage) => void,
): SafeStoragePort {
	if (platform !== "darwin") return storage;
	const observe = (stage: CredentialCryptoStage) => {
		try {
			observeStage?.(stage);
		} catch {
			// Optional smoke observation must not change native operation outcomes.
		}
	};
	return {
		async isEncryptionAvailable() {
			try {
				observe("async-ready-enter");
				const ready = await storage.isAsyncEncryptionAvailable();
				observe("async-ready-return");
				if (!ready) return false;
				// Electron reports encryptor readiness even when its key provider failed.
				// Prove usable crypto with public, ephemeral data; never persist or log it.
				observe("probe-encrypt-enter");
				const encrypted = await storage.encryptStringAsync(PROBE);
				observe("probe-encrypt-return");
				if (!encrypted.length || encrypted.equals(Buffer.from(PROBE))) return false;
				observe("probe-decrypt-enter");
				const decrypted = await storage.decryptStringAsync(encrypted);
				observe("probe-decrypt-return");
				return decrypted.result === PROBE;
			} catch {
				return false;
			}
		},
		getSelectedStorageBackend: () => storage.getSelectedStorageBackend(),
		encryptString: (value) => storage.encryptStringAsync(value),
		// Reading status must not rewrite ciphertext, including rotation recommendations.
		decryptString: async (value) => (await storage.decryptStringAsync(value)).result,
	};
}
