import type { LocalState } from "./local-state.ts";

export type SidebarSection = "pinned" | "projects" | "recent";
export type SidebarLayoutMove =
	| {
			readonly kind: "section";
			readonly moved: SidebarSection;
			readonly before: SidebarSection | null;
			readonly expectedRevision: number;
	  }
	| {
			readonly kind: "project";
			readonly moved: string;
			readonly before: string | null;
			readonly knownIds: readonly string[];
			readonly expectedRevision: number;
	  };
type Layout = {
	readonly sections: readonly SidebarSection[];
	readonly projects: readonly string[];
	readonly revision: number;
};
export type SidebarLayoutSnapshot = Layout & {
	readonly busy: boolean;
	readonly failed: boolean;
	readonly incompatible: boolean;
	readonly stale: boolean;
	readonly pending: SidebarLayoutMove | null;
};

const key = "sidebar.layout";
const maxLength = 30000;
const maxProjects = 1024;
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const sections: readonly SidebarSection[] = Object.freeze(["pinned", "projects", "recent"]);
const defaults: Layout = Object.freeze({ sections, projects: Object.freeze([]), revision: 0 });
const isSection = (value: unknown): value is SidebarSection =>
	value === "pinned" || value === "projects" || value === "recent";

function read(raw: string | null): Layout | null {
	if (raw === null) return defaults;
	if (raw.length > maxLength) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!value ||
			typeof value !== "object" ||
			Object.keys(value).length !== 4 ||
			!("version" in value) ||
			value.version !== 1 ||
			!("revision" in value) ||
			typeof value.revision !== "number" ||
			!Number.isSafeInteger(value.revision) ||
			value.revision < 1 ||
			!("sections" in value) ||
			!Array.isArray(value.sections) ||
			value.sections.length !== sections.length ||
			!value.sections.every(isSection) ||
			new Set(value.sections).size !== sections.length ||
			!("projects" in value) ||
			!Array.isArray(value.projects) ||
			value.projects.length > maxProjects ||
			!value.projects.every((value: unknown): value is string => typeof value === "string" && id.test(value)) ||
			new Set(value.projects).size !== value.projects.length
		)
			return null;
		return Object.freeze({
			sections: Object.freeze([...value.sections]),
			projects: Object.freeze([...value.projects]),
			revision: value.revision,
		});
	} catch {
		return null;
	}
}

/** Add newly loaded identities without replacing or pruning an earlier navigation window. */
export function mergeOrder(stored: readonly string[], knownIds: readonly string[]): string[] {
	return [...new Set([...stored, ...knownIds])];
}

function moveBefore<T extends string>(order: readonly T[], moved: T, before: T | null): T[] {
	if (moved === before) return [...order];
	const next = order.filter((item) => item !== moved);
	next.splice(before === null ? next.length : next.indexOf(before), 0, moved);
	return next;
}

/** Browser-store presentation only. One locked record owns both orders, never runtime membership or grants. */
export class SidebarLayoutSession {
	readonly #local: LocalState;
	readonly #listeners = new Set<() => void>();
	#request: AbortController | undefined;
	#disposed = false;
	#state: SidebarLayoutSnapshot;
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
	orderedProjects = (knownIds: readonly string[]): string[] => {
		const known = new Set(knownIds);
		return mergeOrder(this.#state.projects, knownIds).filter((item) => known.has(item));
	};
	#publish(patch: Partial<SidebarLayoutSnapshot>) {
		if (this.#disposed) return;
		this.#state = Object.freeze({ ...this.#state, ...patch });
		for (const listener of this.#listeners) listener();
	}
	#apply(saved: Layout, action: SidebarLayoutMove): Layout | null {
		if (action.kind === "section") {
			if (!isSection(action.moved) || (action.before !== null && !isSection(action.before))) return null;
			return { ...saved, sections: moveBefore(saved.sections, action.moved, action.before) };
		}
		if (
			action.knownIds.length > maxProjects ||
			!action.knownIds.every((value) => typeof value === "string" && id.test(value)) ||
			!action.knownIds.includes(action.moved)
		)
			return null;
		const projects = mergeOrder(saved.projects, action.knownIds);
		if (projects.length > maxProjects || (action.before !== null && !projects.includes(action.before))) return null;
		return { ...saved, projects: moveBefore(projects, action.moved, action.before) };
	}
	async #run(action: SidebarLayoutMove | null): Promise<boolean> {
		if (this.#disposed || this.#request || (action && this.#state.incompatible)) return false;
		const controller = new AbortController();
		this.#request = controller;
		this.#publish({ busy: true, failed: false, stale: false, ...(action ? { pending: action } : {}) });
		const timeout = setTimeout(() => controller.abort(), 15000);
		let abort: (() => void) | undefined;
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
					if (pending && pending.expectedRevision !== saved.revision) {
						// A changed tab wins. Retrying must not rebase an old drop onto its new layout.
						this.#publish({ pending: null, stale: true, failed: true });
						return false;
					}
					if (!action) {
						if (pending) this.#publish({ failed: true });
						return true;
					}
					const next = this.#apply(saved, action);
					if (!next) {
						this.#publish({ pending: null, failed: true });
						return false;
					}
					if (
						next.sections.join(",") === saved.sections.join(",") &&
						next.projects.join(",") === saved.projects.join(",")
					) {
						this.#publish({ pending: null });
						return true;
					}
					const value = JSON.stringify({ version: 1, ...next, revision: saved.revision + 1 });
					const checked = read(value);
					if (!checked) {
						this.#publish({ pending: null, failed: true });
						return false;
					}
					this.#local.persistValue({ kind: "value", key, value });
					// No await between revision admission, the atomic storage write, and publication.
					this.#publish({ ...checked, pending: null });
					return true;
				}),
				new Promise<never>((_, reject) => {
					abort = () => reject(new Error("WAIT_ABORTED"));
					controller.signal.addEventListener("abort", abort, { once: true });
				}),
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
	moveSection = (moved: SidebarSection, before: SidebarSection | null, expectedRevision: number): Promise<boolean> => {
		if (this.#state.pending) return Promise.resolve(false);
		return this.#run(Object.freeze({ kind: "section", moved, before, expectedRevision }));
	};
	moveProject = (
		moved: string,
		before: string | null,
		knownIds: readonly string[],
		expectedRevision: number,
	): Promise<boolean> => {
		if (this.#state.pending) return Promise.resolve(false);
		return this.#run(
			Object.freeze({ kind: "project", moved, before, knownIds: Object.freeze([...knownIds]), expectedRevision }),
		);
	};
	/** Re-read, but never replay, a failed action. A newer revision invalidates its captured intent. */
	refresh = (): Promise<boolean> => this.#run(null);
	/** Only storage failures retain an action. Recheck its original revision before an explicit retry. */
	retry = (): Promise<boolean> => this.#run(this.#state.pending);
}
