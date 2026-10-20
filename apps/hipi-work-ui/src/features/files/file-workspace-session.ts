import type { FileTarget } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { PreviewClient } from "@hipi/work-runtime/previews/protocol";
import { type ArtifactReference, EditorSession } from "./editor-session.ts";
import type { EditorViewMemory } from "./editor-view-memory.ts";
import type { FileTreeMemory } from "./file-tree-model.ts";
import { PreviewSession } from "./preview-session.ts";

export const FILE_WORKSPACE_LIMIT = 16;
export const FILE_AUTOSAVE_DELAY = 3000;
type TabIdentity = { id: string; target: FileTarget; pinned: boolean };
export type EditorTab = TabIdentity & {
	kind: "editor";
	editor: EditorSession;
	view: EditorViewMemory;
	reference?: ArtifactReference;
};
export type PreviewTab = TabIdentity & { kind: "preview"; preview: PreviewSession };
export type WorkspaceFileTab = EditorTab | PreviewTab;
export type FileWorkspaceSnapshot = {
	tabs: readonly WorkspaceFileTab[];
	activeId?: string;
	limitReached: boolean;
};
type TabResources = { unsubscribe: () => void; timer?: ReturnType<typeof setTimeout> };

export function sameFileTarget(left: FileTarget, right: FileTarget) {
	return left.workspaceId === right.workspaceId && left.rootId === right.rootId && left.path === right.path;
}

/**
 * Owns bounded tabs, never a second copy of file text or revisions.
 * Each editor remains the only writer for its target. All guards inspect every tab.
 */
export class FileWorkspaceSession {
	private state: FileWorkspaceSnapshot = { tabs: [], limitReached: false };
	private listeners = new Set<() => void>();
	private resources = new Map<string, TabResources>();
	private sequence = 0;
	private closeSequence = 0;
	private workspaceId = "";
	private activeByWorkspace = new Map<string, string>();
	private closed = false;
	private files: FileClient;
	private previews?: PreviewClient;
	readonly layout = { treeOpen: true, treeWidth: 240 };
	private trees = new Map<string, FileTreeMemory>();
	constructor(files: FileClient, previews?: PreviewClient) {
		this.files = files;
		this.previews = previews;
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(state = this.state) {
		if (this.closed) return;
		this.state = { ...state };
		for (const listener of this.listeners) listener();
	}
	get protected() {
		return this.state.tabs.some((tab) => tab.kind === "editor" && tab.editor.protected);
	}
	treeMemory(target: Pick<FileTarget, "workspaceId" | "rootId">) {
		const key = JSON.stringify([target.workspaceId, target.rootId]);
		let memory = this.trees.get(key);
		if (!memory) {
			// Only presentation state is evicted; tab contents and revisions are never evicted.
			const oldest = this.trees.keys().next().value;
			if (this.trees.size >= 64 && oldest !== undefined) this.trees.delete(oldest);
			memory = { expanded: [""], cursors: {}, scrollTop: 0 };
			this.trees.set(key, memory);
		}
		return memory;
	}
	activate() {
		this.closed = false;
	}
	setWorkspace(workspaceId: string) {
		if (this.workspaceId !== workspaceId) this.closeSequence++;
		this.workspaceId = workspaceId;
		const activeId = this.activeByWorkspace.get(workspaceId);
		this.publish({
			...this.state,
			activeId:
				this.state.tabs.find((tab) => tab.id === activeId)?.id ??
				this.state.tabs.find((tab) => tab.target.workspaceId === workspaceId)?.id,
		});
	}
	select(id: string) {
		const tab = this.state.tabs.find((item) => item.id === id);
		if (!tab) return;
		this.activeByWorkspace.set(tab.target.workspaceId, id);
		this.publish({ ...this.state, activeId: id });
	}
	pin(id: string) {
		if (!this.state.tabs.some((tab) => tab.id === id && !tab.pinned)) return;
		this.publish({
			...this.state,
			tabs: this.state.tabs.map((tab) => (tab.id === id && !tab.pinned ? { ...tab, pinned: true } : tab)),
		});
	}
	move(id: string, targetId: string, placement: "before" | "after" = "before") {
		const tab = this.state.tabs.find((item) => item.id === id);
		const target = this.state.tabs.find((item) => item.id === targetId);
		if (!tab || !target || id === targetId || tab.target.workspaceId !== target.target.workspaceId) return;
		const tabs = this.state.tabs.filter((item) => item.id !== id);
		tabs.splice(tabs.findIndex((item) => item.id === targetId) + (placement === "after" ? 1 : 0), 0, tab);
		this.publish({ ...this.state, tabs });
	}
	private release(tab: WorkspaceFileTab) {
		const resource = this.resources.get(tab.id);
		clearTimeout(resource?.timer);
		resource?.unsubscribe();
		this.resources.delete(tab.id);
		if (tab.kind === "editor") tab.editor.dispose();
		else tab.preview.dispose();
	}
	private remove(ids: ReadonlySet<string>) {
		const tabs = this.state.tabs.filter((tab) => !ids.has(tab.id));
		const oldIndex = this.state.tabs
			.filter((tab) => tab.target.workspaceId === this.workspaceId)
			.findIndex((tab) => tab.id === this.state.activeId);
		for (const tab of this.state.tabs) if (ids.has(tab.id)) this.release(tab);
		for (const workspace of this.activeByWorkspace.keys())
			if (!tabs.some((tab) => tab.target.workspaceId === workspace)) this.activeByWorkspace.delete(workspace);
		const remaining = tabs.filter((tab) => tab.target.workspaceId === this.workspaceId);
		const activeId = remaining.some((tab) => tab.id === this.state.activeId)
			? this.state.activeId
			: remaining[Math.min(Math.max(oldIndex, 0), remaining.length - 1)]?.id;
		if (activeId) this.activeByWorkspace.set(this.workspaceId, activeId);
		this.publish({ tabs, activeId, limitReached: false });
	}
	/** Used only after an explicit discard decision. IDs never get reused, even after clear. */
	discard(ids: readonly string[]) {
		this.remove(new Set(ids));
	}
	private changed(id: string) {
		const tab = this.state.tabs.find((item) => item.id === id);
		const resource = this.resources.get(id);
		if (!tab || !resource || this.closed) return;
		clearTimeout(resource.timer);
		resource.timer = undefined;
		if (tab.kind === "editor") {
			const state = tab.editor.snapshot();
			if (tab.editor.protected && !tab.pinned) this.pin(id);
			if (
				state.document?.writable &&
				state.document.text !== state.document.baseline.text &&
				!state.operation &&
				!state.error &&
				!state.autosavePaused &&
				state.unknown === undefined
			) {
				resource.timer = setTimeout(() => {
					resource.timer = undefined;
					if (this.state.tabs.some((item) => item.id === id && item.kind === "editor" && item.editor === tab.editor))
						void tab.editor.save();
				}, FILE_AUTOSAVE_DELAY);
			}
		}
		this.publish();
	}
	private append(tab: WorkspaceFileTab) {
		if (this.closed) return false;
		const transient = this.state.tabs.find(
			(item) =>
				item.target.workspaceId === tab.target.workspaceId &&
				!item.pinned &&
				(item.kind !== "editor" || !item.editor.protected),
		);
		if (transient) this.remove(new Set([transient.id]));
		if (this.state.tabs.length >= FILE_WORKSPACE_LIMIT) {
			this.publish({ ...this.state, limitReached: true });
			return false;
		}
		const session = tab.kind === "editor" ? tab.editor : tab.preview;
		this.resources.set(tab.id, { unsubscribe: session.subscribe(() => this.changed(tab.id)) });
		this.activeByWorkspace.set(tab.target.workspaceId, tab.id);
		this.publish({ tabs: [...this.state.tabs, tab], activeId: tab.id, limitReached: false });
		return true;
	}
	async open(
		target: FileTarget,
		writable?: boolean,
		options: { pinned?: boolean; reference?: ArtifactReference } = {},
	) {
		if (this.closed) return;
		const existing = this.state.tabs.find((tab) => tab.kind === "editor" && sameFileTarget(tab.target, target));
		if (existing) {
			if (options.pinned) this.pin(existing.id);
			const reference = options.reference;
			if (reference)
				this.publish({
					...this.state,
					tabs: this.state.tabs.map((tab) => (tab.id === existing.id ? { ...tab, reference: { ...reference } } : tab)),
				});
			this.select(existing.id);
			return;
		}
		const editor = new EditorSession(this.files);
		const tab: EditorTab = {
			id: `file-${++this.sequence}`,
			kind: "editor",
			target: { ...target },
			pinned: options.pinned ?? false,
			editor,
			view: {},
			...(options.reference ? { reference: { ...options.reference } } : {}),
		};
		if (!this.append(tab)) {
			editor.dispose();
			return;
		}
		await editor.open(tab.target, writable, options.reference);
	}
	openArtifact(target: FileTarget, reference: ArtifactReference) {
		return this.open(target, undefined, { pinned: true, reference });
	}
	/** Retry only an empty retained tab, re-reading current root authority before file bytes. */
	async retry(id: string) {
		if (this.closed) return;
		const tab = this.state.tabs.find((item) => item.id === id);
		if (!tab || tab.kind !== "editor") return;
		const state = tab.editor.snapshot();
		if (state.document || state.operation || tab.editor.protected) return;
		await tab.editor.open(tab.target, undefined, tab.reference);
	}
	async openPreview(target: FileTarget, pinned = false) {
		if (this.closed || !this.previews) return;
		const existing = this.state.tabs.find((tab) => tab.kind === "preview" && sameFileTarget(tab.target, target));
		if (existing) {
			if (pinned) this.pin(existing.id);
			this.select(existing.id);
			return;
		}
		const preview = new PreviewSession(this.previews);
		const tab: PreviewTab = {
			id: `file-${++this.sequence}`,
			kind: "preview",
			target: { ...target },
			pinned,
			preview,
		};
		if (!this.append(tab)) {
			preview.dispose();
			return;
		}
		await preview.open(tab.target);
	}
	/** Conditional-save before close; never retry a conflict or an unknown result automatically. */
	async close(
		ids: readonly string[],
		isCurrent: (tab: WorkspaceFileTab) => boolean = () => true,
		canSave: (tab: WorkspaceFileTab) => boolean = () => true,
	) {
		const intent = ++this.closeSequence;
		const requested = this.state.tabs
			.filter((tab) => ids.includes(tab.id))
			.map((tab) => ({
				tab,
				documentTarget: tab.kind === "editor" ? tab.editor.snapshot().document?.target : undefined,
			}));
		const blocked = new Map<string, () => boolean>();
		for (const { tab, documentTarget } of requested) {
			const current = () => {
				const document = tab.kind === "editor" ? tab.editor.snapshot().document : undefined;
				return (
					!this.closed &&
					intent === this.closeSequence &&
					this.state.tabs.some(
						(item) =>
							item.id === tab.id &&
							(tab.kind === "editor"
								? item.kind === "editor" && item.editor === tab.editor
								: item.kind === "preview" && item.preview === tab.preview),
					) &&
					(documentTarget === undefined || document?.target === documentTarget) &&
					(!document || sameFileTarget(document.target, tab.target)) &&
					isCurrent(tab)
				);
			};
			if (!current()) continue;
			if (tab.kind === "editor") {
				// At most two writes: join/start one, then save newer edits once.
				// Continued typing ends this close intent without a destructive prompt.
				let writes = 0;
				let saved = true;
				while (current() && tab.editor.protected && writes < 2) {
					const state = tab.editor.snapshot();
					if (
						(!canSave(tab) && state.operation !== "save") ||
						!state.document?.writable ||
						!sameFileTarget(state.document.target, tab.target) ||
						(state.operation !== undefined && state.operation !== "save") ||
						state.error ||
						state.autosavePaused ||
						state.unknown !== undefined
					)
						break;
					writes++;
					saved = await tab.editor.save();
					if (!saved) break;
				}
				if (!current()) continue;
				if (saved && writes === 2 && tab.editor.protected) continue;
				if (tab.editor.protected) {
					blocked.set(tab.id, current);
					continue;
				}
			}
			this.remove(new Set([tab.id]));
		}
		if (this.closed || intent !== this.closeSequence) return [];
		return [...blocked].filter(([, current]) => current()).map(([id]) => id);
	}
	/** Hiding releases handles, not tab identity. Reopening reauthorizes the exact target. */
	suspendPreviews() {
		for (const tab of this.state.tabs) if (tab.kind === "preview") tab.preview.clear();
	}
	resumePreview(id: string) {
		const tab = this.state.tabs.find((item) => item.id === id);
		if (tab?.kind === "preview" && !tab.preview.snapshot().target) void tab.preview.open(tab.target);
	}
	clear() {
		this.remove(new Set(this.state.tabs.map((tab) => tab.id)));
	}
	dispose() {
		this.closeSequence++;
		for (const tab of this.state.tabs) this.release(tab);
		this.state = { tabs: [], limitReached: false };
		this.activeByWorkspace.clear();
		this.trees.clear();
		this.closed = true;
		this.listeners.clear();
	}
}
