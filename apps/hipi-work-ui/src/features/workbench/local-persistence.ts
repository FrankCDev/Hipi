import { LIMITS, PROTOCOL_VERSION, parseRequest, type Submit } from "@hipi/work-runtime/contracts";
import { validPanelWidth } from "./file-panel-controller.ts";

export type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
export type SavedValue = {
	kind: "value";
	key: string;
	value: string;
	revision?: string;
	handoffRequestId?: string;
};
export type SavedEntry = SavedValue | { kind: "pending"; key: string; input: Submit; confirmed: boolean };

const id = /^[a-zA-Z0-9_-]{1,128}$/;
const scope = "[a-zA-Z0-9_-]{1,128}\\.[a-zA-Z0-9_-]{1,128}";
const draftKey = new RegExp(`^draft\\.${scope}$`);
const taskDraftKey = /^task-draft\.[a-zA-Z0-9_-]{1,128}$/;

export function validTaskDraft(key: string, value: string): boolean {
	return taskDraftKey.test(key) && value.length <= LIMITS.text;
}

export function browserStorage(): BrowserStorage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

/** Small independent records prevent one conversation's edits from overwriting other conversations. */
export class LocalPersistence {
	readonly #storage: BrowserStorage;
	readonly #prefix: string;
	readonly #storeId: string;
	constructor(storeId: string, storage: BrowserStorage) {
		if (!id.test(storeId)) throw new Error("Invalid store identity");
		this.#storeId = storeId;
		this.#storage = storage;
		this.#prefix = `hipi.work.local.v1.${storeId}.`;
	}
	#parse(raw: string | null): SavedEntry | null {
		// A command embeds JSON text inside its value; bounded prepared input is escaped twice.
		if (!raw || raw.length > 65536) return null;
		try {
			const entry: unknown = JSON.parse(raw);
			if (
				!entry ||
				typeof entry !== "object" ||
				!("version" in entry) ||
				entry.version !== 1 ||
				!("storeId" in entry) ||
				entry.storeId !== this.#storeId ||
				!("key" in entry) ||
				typeof entry.key !== "string" ||
				!("kind" in entry)
			)
				return null;
			if (entry.kind === "value" && "value" in entry && typeof entry.value === "string") {
				if (
					("revision" in entry &&
						(typeof entry.revision !== "string" ||
							!id.test(entry.revision) ||
							(!draftKey.test(entry.key) && !taskDraftKey.test(entry.key)))) ||
					("handoffRequestId" in entry &&
						(typeof entry.handoffRequestId !== "string" ||
							!id.test(entry.handoffRequestId) ||
							!draftKey.test(entry.key)))
				)
					return null;
				if (
					(entry.key === "file-panel.open" && (entry.value === "true" || entry.value === "false")) ||
					(entry.key === "file-panel.width" && validPanelWidth(entry.value)) ||
					(draftKey.test(entry.key) && entry.value.length <= LIMITS.text) ||
					validTaskDraft(entry.key, entry.value) ||
					(/^command\.tool-packs\.(workspace\.[a-zA-Z0-9_-]{1,128}|conversation\.[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9_-]{1,128})$/.test(
						entry.key,
					) &&
						entry.value.length <= 12000) ||
					(/^command\.(catalog|permissions\.[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9_-]{1,128})$/.test(entry.key) &&
						entry.value.length <= 30000) ||
					(/^workspace-expanded\.[a-zA-Z0-9_-]{1,128}$/.test(entry.key) &&
						(entry.value === "true" || entry.value === "false")) ||
					((entry.key === "workspace" || entry.key === "conversation") && (entry.value === "" || id.test(entry.value)))
				)
					return {
						kind: "value",
						key: entry.key,
						value: entry.value,
						...("revision" in entry && typeof entry.revision === "string" ? { revision: entry.revision } : {}),
						...("handoffRequestId" in entry && typeof entry.handoffRequestId === "string"
							? { handoffRequestId: entry.handoffRequestId }
							: {}),
					};
			}
			if (
				entry.kind === "pending" &&
				"input" in entry &&
				"confirmed" in entry &&
				typeof entry.confirmed === "boolean"
			) {
				const request = parseRequest({ version: PROTOCOL_VERSION, method: "submit", params: entry.input });
				if (
					request.method !== "submit" ||
					entry.key !== `${request.params.workspaceId}.${request.params.conversationId}`
				)
					return null;
				return { kind: "pending", key: entry.key, input: request.params, confirmed: entry.confirmed };
			}
		} catch {
			/* Corrupt or incompatible local data is never sent to the runtime. */
		}
		return null;
	}
	load(): SavedEntry[] {
		const entries: SavedEntry[] = [];
		for (let i = 0; i < this.#storage.length; i++) {
			const key = this.#storage.key(i);
			if (!key?.startsWith(this.#prefix)) continue;
			const entry = this.#parse(this.#storage.getItem(key));
			if (entry && key === `${this.#prefix}${entry.kind}.${entry.key}`) entries.push(entry);
		}
		return entries;
	}
	readValue(key: string): SavedValue | null {
		const raw = this.#storage.getItem(`${this.#prefix}value.${key}`);
		const entry = this.#parse(raw);
		if (raw !== null && (entry?.kind !== "value" || entry.key !== key)) throw new Error("Invalid local state");
		return entry?.kind === "value" ? entry : null;
	}
	clearDraft(key: string, expected: string, revision: string): boolean {
		const entry = this.#parse(this.#storage.getItem(`${this.#prefix}value.${key}`));
		if (entry?.kind !== "value" || entry.value !== expected) return false;
		this.save({ ...entry, value: "", revision });
		return true;
	}
	matchesDraft(key: string, value: string | undefined): boolean {
		const entry = this.#parse(this.#storage.getItem(`${this.#prefix}value.${key}`));
		return entry?.kind === "value" ? entry.value === value : value === undefined || value === "";
	}
	save(entry: SavedEntry) {
		const key = `${this.#prefix}${entry.kind}.${entry.key}`;
		const raw = JSON.stringify({ version: 1, storeId: this.#storeId, ...entry });
		if (!this.#parse(raw)) throw new Error("Invalid local state");
		const previous = this.#parse(this.#storage.getItem(key));
		if (previous?.kind === "pending" && entry.kind === "pending") {
			if (entry.confirmed && previous.input.requestId !== entry.input.requestId)
				throw new Error("Cannot confirm a different pending request");
			if (
				previous.input.requestId === entry.input.requestId &&
				JSON.stringify(previous.input) !== JSON.stringify(entry.input)
			)
				throw new Error("Pending request payload is immutable");
			if (!previous.confirmed && previous.input.requestId !== entry.input.requestId)
				throw new Error("Another unresolved request exists for this conversation");
		}
		this.#storage.setItem(key, raw);
	}
}
