import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError, type CredentialState } from "@hipi/work-runtime/contracts";

import { credentialProvider, credentialSecret } from "./credential-protocol.ts";

export interface SafeStoragePort {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend(): string;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}
const MAX_BYTES = 32768;
/** Main-process-only store. No plaintext fallback, cache, or secret-bearing error messages. */
export class CredentialStore {
	readonly #path: string;
	readonly #storage: SafeStoragePort;
	readonly #platform: string;
	readonly #replace: typeof rename;
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;
	constructor(path: string, storage: SafeStoragePort, platform = process.platform, replace = rename) {
		this.#path = path;
		this.#storage = storage;
		this.#platform = platform;
		this.#replace = replace;
	}
	#available() {
		try {
			return (
				this.#storage.isEncryptionAvailable() &&
				(this.#platform !== "linux" ||
					["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(this.#storage.getSelectedStorageBackend()))
			);
		} catch {
			return false;
		}
	}
	#serial<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#pending >= 16) return Promise.reject(new AppError("CAPACITY_EXCEEDED"));
		this.#pending++;
		const result = this.#tail.then(operation).finally(() => {
			this.#pending--;
		});
		this.#tail = result.catch(() => undefined);
		return result;
	}
	async #read(): Promise<string | undefined> {
		let file: FileHandle;
		try {
			file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
			throw new AppError("INTERNAL");
		}
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES) throw new AppError("INTERNAL");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_BYTES) throw new AppError("INTERNAL");
			const value: unknown = JSON.parse(this.#storage.decryptString(buffer.subarray(0, bytesRead)));
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				!("version" in value) ||
				value.version !== 1 ||
				Object.keys(value).some((key) => !["version", "openai"].includes(key))
			)
				throw new AppError("INTERNAL");
			return "openai" in value ? credentialSecret(value.openai) : undefined;
		} catch {
			throw new AppError("INTERNAL");
		} finally {
			await file.close();
		}
	}
	status(provider: string): Promise<CredentialState> {
		credentialProvider(provider);
		return this.#serial(async () => {
			if (!this.#available()) return "unavailable";
			try {
				return (await this.#read()) === undefined ? "missing" : "configured";
			} catch {
				return "locked";
			}
		});
	}
	get(provider: string): Promise<string | undefined> {
		credentialProvider(provider);
		return this.#serial(async () => {
			if (!this.#available()) throw new AppError("INTERNAL");
			return this.#read();
		});
	}
	set(provider: string, secret: string): Promise<void> {
		credentialProvider(provider);
		credentialSecret(secret);
		return this.#write(secret);
	}
	remove(provider: string): Promise<void> {
		credentialProvider(provider);
		return this.#write(undefined);
	}
	#write(secret: string | undefined): Promise<void> {
		return this.#serial(async () => {
			if (!this.#available()) throw new AppError("INTERNAL");
			// A damaged or locked existing file must never be replaced, including by deletion.
			await this.#read();
			const temporary = `${this.#path}.${randomUUID()}.tmp`;
			try {
				const encrypted = this.#storage.encryptString(JSON.stringify({ version: 1, openai: secret }));
				if (!encrypted.length || encrypted.length > MAX_BYTES) throw new AppError("INTERNAL");
				await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(encrypted);
					await file.sync();
				} finally {
					await file.close();
				}
				await this.#replace(temporary, this.#path);
			} catch {
				throw new AppError("INTERNAL");
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
		});
	}
}
