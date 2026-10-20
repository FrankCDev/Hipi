import { type ConfigError, defaultConfig, parseConfig, type ThemeConfig, validateConfig } from "./config.ts";

// Keep the established storage address so upgrades find existing v1 preferences.
export const themeStorageKey = "hipi-work.preferences.v1";
export const rejectedThemeStorageKey = "hipi-work.preferences.rejected";
export const previousThemeStorageKey = "hipi-work.preferences.previous";
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
export type StorageStatus = "available" | "memory" | "invalid";
export type ThemeUpdateResult =
	| { ok: true; value: ThemeConfig; status: "available" | "memory" }
	| { ok: false; error: ConfigError };
export class ThemeStore {
	private saved = defaultConfig();
	private preview: ThemeConfig | undefined;
	private original: string | undefined;
	private previous: string | undefined;
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
			if (parsed.ok) {
				this.saved = parsed.value;
				const source: unknown = JSON.parse(raw);
				if (typeof source === "object" && source !== null && "version" in source && source.version === 1)
					this.previous = raw;
			} else {
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
	update(value: unknown): ThemeUpdateResult {
		const parsed = validateConfig(value);
		if (!parsed.ok) return parsed;
		this.saved = parsed.value;
		this.preview = undefined;
		const status = this.persist();
		return { ok: true, value: this.current, status };
	}
	save(): "available" | "memory" {
		this.saved = this.current;
		this.preview = undefined;
		return this.persist();
	}
	private persist(): "available" | "memory" {
		try {
			if (!this.storage) throw new Error("Storage unavailable");
			// Preserve pre-migration v1 bytes before replacement. Later v2 saves leave this backup alone.
			// A failed backup must not destroy the user's recoverable original.
			if (this.original !== undefined) this.storage.setItem(rejectedThemeStorageKey, this.original);
			if (this.previous !== undefined) this.storage.setItem(previousThemeStorageKey, this.previous);
			this.storage.setItem(themeStorageKey, JSON.stringify(this.saved));
			this.previous = undefined;
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
