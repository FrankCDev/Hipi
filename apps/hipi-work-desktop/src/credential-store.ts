import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError, type CredentialState } from "@hipi/work-runtime/contracts";

import {
	type CredentialProvider,
	credentialProvider,
	credentialSecret,
	MAX_CREDENTIAL_PROVIDERS,
} from "./credential-protocol.ts";

export interface SafeStoragePort {
	isEncryptionAvailable(): boolean | Promise<boolean>;
	getSelectedStorageBackend(): string;
	encryptString(value: string): Buffer | Promise<Buffer>;
	decryptString(value: Buffer): string | Promise<string>;
}
const MAX_BYTES = 32768;
export type CredentialStatusStage =
	| "status-enter"
	| "availability-enter"
	| "availability-return"
	| "file-read-enter"
	| "file-read-return"
	| "status-return";
/** Main-process-only store. No plaintext fallback, cache, or secret-bearing error messages. */
export class CredentialStore {
	readonly #path: string;
	readonly #storage: SafeStoragePort;
	readonly #platform: string;
	readonly #replace: typeof rename;
	readonly #observeStatus?: (stage: CredentialStatusStage) => void;
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;
	constructor(
		path: string,
		storage: SafeStoragePort,
		platform = process.platform,
		replace = rename,
		observeStatus?: (stage: CredentialStatusStage) => void,
	) {
		this.#path = path;
		this.#storage = storage;
		this.#platform = platform;
		this.#replace = replace;
		this.#observeStatus = observeStatus;
	}
	#observe(stage: CredentialStatusStage) {
		try {
			this.#observeStatus?.(stage);
		} catch {
			// Optional smoke diagnostics must never affect credential operations.
		}
	}
	async #available() {
		try {
			return (
				(await this.#storage.isEncryptionAvailable()) &&
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
	async #read(): Promise<Map<CredentialProvider, string>> {
		let file: FileHandle;
		try {
			file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
			throw new AppError("INTERNAL");
		}
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_BYTES) throw new AppError("INTERNAL");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_BYTES) throw new AppError("INTERNAL");
			const value: unknown = JSON.parse(await this.#storage.decryptString(buffer.subarray(0, bytesRead)));
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				!("version" in value) ||
				(value.version !== 1 && value.version !== 2)
			)
				throw new AppError("INTERNAL");
			const providers = new Map<CredentialProvider, string>();
			if (value.version === 1) {
				if (Object.keys(value).some((key) => !["version", "openai"].includes(key))) throw new AppError("INTERNAL");
				if ("openai" in value) providers.set("openai", credentialSecret(value.openai));
			} else {
				if (
					Object.keys(value).some((key) => !["version", "providers"].includes(key)) ||
					!("providers" in value) ||
					!value.providers ||
					typeof value.providers !== "object" ||
					Array.isArray(value.providers)
				)
					throw new AppError("INTERNAL");
				const entries = Object.entries(value.providers);
				if (entries.length > MAX_CREDENTIAL_PROVIDERS) throw new AppError("INTERNAL");
				for (const [provider, secret] of entries) providers.set(credentialProvider(provider), credentialSecret(secret));
			}
			return providers;
		} catch {
			throw new AppError("INTERNAL");
		} finally {
			await file.close().catch(() => {
				throw new AppError("INTERNAL");
			});
		}
	}
	status(provider: string): Promise<CredentialState> {
		const identity = credentialProvider(provider);
		this.#observe("status-enter");
		return this.#serial(async () => {
			try {
				this.#observe("availability-enter");
				const available = await this.#available();
				this.#observe("availability-return");
				if (!available) return "unavailable";
				this.#observe("file-read-enter");
				try {
					return (await this.#read()).has(identity) ? "configured" : "missing";
				} catch {
					return "locked";
				} finally {
					this.#observe("file-read-return");
				}
			} finally {
				this.#observe("status-return");
			}
		});
	}
	get(provider: string): Promise<string | undefined> {
		const identity = credentialProvider(provider);
		return this.#serial(async () => {
			if (!(await this.#available())) throw new AppError("INTERNAL");
			return (await this.#read()).get(identity);
		});
	}
	set(provider: string, secret: string): Promise<void> {
		const identity = credentialProvider(provider);
		credentialSecret(secret);
		return this.#write(identity, secret);
	}
	remove(provider: string): Promise<void> {
		return this.#write(credentialProvider(provider), undefined);
	}
	#write(provider: CredentialProvider, secret: string | undefined): Promise<void> {
		return this.#serial(async () => {
			if (!(await this.#available())) throw new AppError("INTERNAL");
			// A damaged or locked existing file must never be replaced, including by deletion.
			const providers = await this.#read();
			if (secret === undefined) providers.delete(provider);
			else {
				if (!providers.has(provider) && providers.size >= MAX_CREDENTIAL_PROVIDERS)
					throw new AppError("CAPACITY_EXCEEDED");
				providers.set(provider, secret);
			}
			// Reads retain v1 intact. An explicit set/remove upgrades the complete encrypted map.
			const plaintext = JSON.stringify({ version: 2, providers: Object.fromEntries(providers) });
			if (Buffer.byteLength(plaintext) > MAX_BYTES) throw new AppError("CAPACITY_EXCEEDED");
			const temporary = `${this.#path}.${randomUUID()}.tmp`;
			try {
				const encrypted = await this.#storage.encryptString(plaintext);
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
				// POSIX also needs the directory entry flushed after rename. Windows does not
				// support opening directories this way; native durability remains platform-qualified.
				if (this.#platform !== "win32") {
					const directory = await open(dirname(this.#path), constants.O_RDONLY | constants.O_DIRECTORY);
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				}
			} catch {
				throw new AppError("INTERNAL");
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
		});
	}
}
