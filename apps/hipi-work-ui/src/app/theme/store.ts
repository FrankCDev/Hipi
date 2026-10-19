import { defaultConfig, parseConfig, type ThemeConfig, validateConfig } from "./config.ts";

export const themeStorageKey = "hipi-work.preferences.v1";
export const rejectedThemeStorageKey = "hipi-work.preferences.rejected";
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
export type StorageStatus = "available" | "memory" | "invalid";
export class ThemeStore {
	private saved = defaultConfig();
	private preview: ThemeConfig | undefined;
	private original: string | undefined;
	status: StorageStatus = "available";
	private storage: ThemeStorage | undefined;
	constructor(storage?: ThemeStorage) {
		this.storage = storage;
		if (!storage) {
			this.status = "memory";
			return;
		}
		try {
			this.original = storage.getItem(rejectedThemeStorageKey) ?? undefined;
			const raw = storage.getItem(themeStorageKey);
			if (raw === null) return;
			const parsed = parseConfig(raw);
			if (parsed.ok) this.saved = parsed.value;
			else {
				this.original = raw;
				this.status = "invalid";
			}
		} catch {
			this.status = "memory";
		}
	}
	get current(): ThemeConfig {
		return structuredClone(this.preview ?? this.saved);
	}
	get rejectedOriginal(): string | undefined {
		return this.original;
	}
	setPreview(value: unknown) {
		const parsed = validateConfig(value);
		if (parsed.ok) this.preview = parsed.value;
		return parsed;
	}
	cancel() {
		this.preview = undefined;
	}
	save(): StorageStatus {
		this.saved = this.current;
		this.preview = undefined;
		try {
			if (!this.storage) throw new Error("Storage unavailable");
			// Preserve rejected bytes before replacing the active record. If backup fails,
			// use memory only rather than destroying the user's recoverable original.
			if (this.original !== undefined) this.storage.setItem(rejectedThemeStorageKey, this.original);
			this.storage.setItem(themeStorageKey, JSON.stringify(this.saved));
			this.status = "available";
		} catch {
			this.status = "memory";
		}
		return this.status;
	}
	export(): string {
		return JSON.stringify(this.current, null, 2);
	}
}
