import { AppError, type CredentialState } from "@hipi/work-runtime/contracts";
import { decode, encode, exact, identifier, MAX_ACTIVE, WAIT_MS } from "../ipc/protocol.ts";
import { credentialProvider, credentialSecret, credentialState } from "./protocol.ts";

export interface RuntimeCredentials {
	get(provider: string): Promise<string | undefined>;
	status(provider: string): Promise<CredentialState>;
}
/** Private utility-to-main capability; never exposed by the renderer bridge. */
export async function credentialReply(
	raw: unknown,
	generation: string,
	credentials: RuntimeCredentials,
): Promise<string> {
	const value = decode(raw);
	exact(value, ["generation", "kind", "id", "operation", "provider"]);
	if (value.generation !== generation || value.kind !== "credentialRequest") throw new AppError("UNAUTHORIZED");
	const id = identifier(value.id);
	const provider = credentialProvider(value.provider);
	if (value.operation !== "get" && value.operation !== "status") throw new AppError("INVALID_REQUEST");
	try {
		const result = value.operation === "get" ? await credentials.get(provider) : await credentials.status(provider);
		return encode({ generation, kind: "credentialResult", id, ok: true, value: result ?? null });
	} catch {
		return encode({ generation, kind: "credentialResult", id, ok: false });
	}
}
export class CredentialRpc implements RuntimeCredentials {
	readonly #generation: string;
	readonly #post: (raw: string) => void;
	readonly #pending = new Map<
		string,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	#next = 0;
	#closed = false;
	constructor(generation: string, post: (raw: string) => void) {
		this.#generation = generation;
		this.#post = post;
	}
	#call(operation: "get" | "status", provider: string): Promise<unknown> {
		credentialProvider(provider);
		if (this.#closed) return Promise.reject(new AppError("CLOSED"));
		if (this.#pending.size >= MAX_ACTIVE) return Promise.reject(new AppError("CAPACITY_EXCEEDED"));
		const id = String(++this.#next);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new AppError("CLOSED"));
			}, WAIT_MS);
			this.#pending.set(id, { resolve, reject, timer });
			try {
				this.#post(encode({ generation: this.#generation, kind: "credentialRequest", id, operation, provider }));
			} catch {
				this.close();
			}
		});
	}
	async get(provider: string): Promise<string | undefined> {
		const value = await this.#call("get", provider);
		return value === null ? undefined : credentialSecret(value);
	}
	async status(provider: string): Promise<CredentialState> {
		return credentialState(await this.#call("status", provider));
	}
	receive(raw: unknown): boolean {
		const value = decode(raw);
		if (value.kind !== "credentialResult") return false;
		if (value.generation !== this.#generation) return true;
		exact(value, value.ok === true ? ["generation", "kind", "id", "ok", "value"] : ["generation", "kind", "id", "ok"]);
		const id = identifier(value.id);
		const pending = this.#pending.get(id);
		if (!pending) return true;
		clearTimeout(pending.timer);
		this.#pending.delete(id);
		if (value.ok === true) pending.resolve(value.value);
		else pending.reject(new AppError("INTERNAL"));
		return true;
	}
	close() {
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AppError("CLOSED"));
		}
		this.#pending.clear();
	}
}
