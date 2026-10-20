import type { SafeStorage } from "electron";
import type { SafeStoragePort } from "./credential-store.ts";

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

/** Darwin keychain IO must not block the main thread. Other platform policies stay unchanged. */
export function createCredentialCrypto(storage: NativeStorage, platform = process.platform): SafeStoragePort {
	if (platform !== "darwin") return storage;
	return {
		async isEncryptionAvailable() {
			try {
				if (!(await storage.isAsyncEncryptionAvailable())) return false;
				// Electron reports encryptor readiness even when its key provider failed.
				// Prove usable crypto with public, ephemeral data; never persist or log it.
				const encrypted = await storage.encryptStringAsync(PROBE);
				if (!encrypted.length || encrypted.equals(Buffer.from(PROBE))) return false;
				return (await storage.decryptStringAsync(encrypted)).result === PROBE;
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
