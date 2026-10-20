import type { LocalState } from "../local-state.ts";
import type { SidebarSection } from "./layout-session.ts";

export type SidebarDisclosureIntent = {
	readonly section: SidebarSection;
	readonly collapsed: boolean;
	readonly expectedRevision: number;
};
type Disclosure = {
	readonly collapsed: Readonly<Record<SidebarSection, boolean>>;
	readonly revisions: Readonly<Record<SidebarSection, number>>;
};
export type SidebarDisclosureSnapshot = Disclosure & {
	readonly busy: boolean;
	readonly failed: boolean;
	readonly incompatible: boolean;
	readonly stale: boolean;
	readonly pending: SidebarDisclosureIntent | null;
};

const key = "sidebar.disclosure";
const maxLength = 1024;
const sections: readonly SidebarSection[] = ["pinned", "projects", "recent"];
const defaults: Disclosure = Object.freeze({
	collapsed: Object.freeze({ pinned: false, projects: false, recent: false }),
	revisions: Object.freeze({ pinned: 0, projects: 0, recent: 0 }),
});

function validSections<T>(
	value: unknown,
	valid: (entry: unknown) => entry is T,
): value is Readonly<Record<SidebarSection, T>> {
	return (
		!!value &&
		typeof value === "object" &&
		Object.keys(value).length === sections.length &&
		sections.every((section) => Object.hasOwn(value, section)) &&
		Object.values(value).every(valid)
	);
}

function read(raw: string | null): Disclosure | null {
	if (raw === null) return defaults;
	if (raw.length > maxLength) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!value ||
			typeof value !== "object" ||
			Object.keys(value).length !== 3 ||
			!("version" in value) ||
			value.version !== 1 ||
			!("collapsed" in value) ||
			!validSections(value.collapsed, (entry): entry is boolean => typeof entry === "boolean") ||
			!("revisions" in value) ||
			!validSections(
				value.revisions,
				(entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
			)
		)
			return null;
		return Object.freeze({
			collapsed: Object.freeze({ ...value.collapsed }),
			revisions: Object.freeze({ ...value.revisions }),
		});
	} catch {
		return null;
	}
}

/** Browser-store disclosure only. Section fences are independent of ordering and of one another. */
export class SidebarDisclosureSession {
	readonly #local: LocalState;
	readonly #listeners = new Set<() => void>();
	#request: AbortController | undefined;
	#disposed = false;
	#state: SidebarDisclosureSnapshot;
	constructor(local: LocalState) {
		this.#local = local;
		const saved = read(local.read(key));
		this.#state = Object.freeze({
			...(saved ?? defaults),
			busy: false,
			failed: false,
			incompatible: saved === null,
			stale: false,
			pending: null,
		});
	}
	getSnapshot = () => this.#state;
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	activate() {
		this.#disposed = false;
	}
	dispose() {
		this.#disposed = true;
		this.#request?.abort();
		this.#request = undefined;
		this.#state = Object.freeze({ ...this.#state, busy: false });
		this.#listeners.clear();
	}
	#publish(patch: Partial<SidebarDisclosureSnapshot>) {
		if (this.#disposed) return;
		this.#state = Object.freeze({ ...this.#state, ...patch });
		for (const listener of this.#listeners) listener();
	}
	async #run(action: SidebarDisclosureIntent | null): Promise<boolean> {
		if (this.#disposed || this.#request || (action && this.#state.incompatible)) return false;
		const controller = new AbortController();
		this.#request = controller;
		this.#publish({ busy: true, failed: false, stale: false, ...(action ? { pending: action } : {}) });
		const timeout = setTimeout(() => controller.abort(), 15000);
		let abort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("WAIT_ABORTED"));
			if (controller.signal.aborted) abort();
			else controller.signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([
				this.#local.withAdmission(key, () => {
					controller.signal.throwIfAborted();
					const saved = read(this.#local.storedValue(key)?.value ?? null);
					if (!saved) {
						this.#publish({ incompatible: true, failed: true });
						return false;
					}
					this.#publish({ ...saved, incompatible: false });
					controller.signal.throwIfAborted();
					const pending = action ?? this.#state.pending;
					if (pending && pending.expectedRevision !== saved.revisions[pending.section]) {
						// Never rebase a queued or failed action over a newer intent for this section.
						this.#publish({ pending: null, stale: true, failed: true });
						return false;
					}
					if (!action) {
						if (pending) this.#publish({ failed: true });
						return true;
					}
					const value = JSON.stringify({
						version: 1,
						collapsed: { ...saved.collapsed, [action.section]: action.collapsed },
						// Even an explicit unchanged value fences older retries from another window.
						revisions: { ...saved.revisions, [action.section]: saved.revisions[action.section] + 1 },
					});
					const checked = read(value);
					if (!checked) {
						this.#publish({ pending: null, failed: true });
						return false;
					}
					this.#local.persistValue({ kind: "value", key, value });
					// No await separates admission, the durable write, and publication.
					this.#publish({ ...checked, pending: null });
					return true;
				}),
				aborted,
			]);
		} catch {
			if (this.#request === controller) this.#publish({ failed: true });
			return false;
		} finally {
			clearTimeout(timeout);
			if (abort) controller.signal.removeEventListener("abort", abort);
			if (this.#request === controller) {
				this.#request = undefined;
				this.#publish({ busy: false });
			}
		}
	}
	setCollapsed = (section: SidebarSection, collapsed: boolean): Promise<boolean> => {
		if (this.#disposed || this.#request || this.#state.pending) return Promise.resolve(false);
		if (!sections.includes(section) || typeof collapsed !== "boolean") {
			this.#publish({ failed: true });
			return Promise.resolve(false);
		}
		return this.#run(Object.freeze({ section, collapsed, expectedRevision: this.#state.revisions[section] }));
	};
	/** Refresh never writes. A newer same-section revision invalidates a failed intent. */
	refresh = (): Promise<boolean> => this.#run(null);
	/** Replay only the captured explicit value, never a toggle derived from newer state. */
	retry = (): Promise<boolean> => this.#run(this.#state.pending);
}
