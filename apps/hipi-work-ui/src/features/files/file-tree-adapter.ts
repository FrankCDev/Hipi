import { FileTree as PierreFileTree } from "@pierre/trees";
import { ClipboardFeedback, type ClipboardStatus } from "../workbench/conversation/markdown/clipboard-feedback.ts";
import type { fileLabels } from "./file-labels.ts";
import {
	FILE_TREE_EXPANSION_LIMIT,
	FILE_TREE_ROW_HEIGHT,
	type FileTreeMemory,
	type FileTreeRow,
	treeModelPath,
} from "./file-tree-model.ts";
import shadowStyles from "./pierre-file-tree-shadow.css?inline";

type TreeSnapshot = {
	scope: string;
	source: object;
	rows: readonly FileTreeRow[];
	expanded: readonly string[];
	selected?: string;
	filter?: string;
	label: string;
	labels: ReturnType<typeof fileLabels>;
	onExpanded: (paths: string[]) => void;
	onLimit: (limited: boolean) => void;
	onActivate: (row: FileTreeRow, pinned: boolean) => void;
	onPreview?: (row: FileTreeRow) => void;
	onCopyStatus?: (status: ClipboardStatus) => void;
	onNoMatches?: (empty: boolean) => void;
};
type TreeContextAction = { id: "copy" | "preview"; label: string; restoreFocus: boolean; run: () => void };

/**
 * Owns only Pierre presentation, never filesystem state. A model path must resolve
 * through the current authorized page projection before any application callback.
 */
export class FileTreeAdapter {
	readonly model: PierreFileTree;
	private snapshot: TreeSnapshot;
	private rows = new Map<string, FileTreeRow>();
	private paths: string[] = [];
	private order = new Map<string, number>();
	private memory: FileTreeMemory;
	private syncing = false;
	private disposed = false;
	private unsubscribe: () => void;
	private detach?: () => void;
	private host?: HTMLElement;
	private restorePosition = true;
	private revealPath?: string;
	private projectionVersion = 0;
	private clipboard?: ClipboardFeedback;
	private noMatches = false;
	private actionPath?: string;

	constructor(memory: FileTreeMemory, snapshot: TreeSnapshot) {
		this.memory = memory;
		this.snapshot = snapshot;
		this.model = new PierreFileTree({
			paths: [],
			initialExpansion: "closed",
			flattenEmptyDirectories: false,
			sort: (left, right) => (this.order.get(left.path) ?? 0) - (this.order.get(right.path) ?? 0),
			itemHeight: FILE_TREE_ROW_HEIGHT,
			overscan: 8,
			stickyFolders: true,
			dragAndDrop: false,
			renaming: false,
			search: false,
			fileTreeSearchMode: "hide-non-matches",
			icons: { set: "minimal", colored: false },
			unsafeCSS: shadowStyles,
			renderRowDecoration: ({ item }) => {
				const row = this.rows.get(item.path);
				if (!row || (row.kind === "entry" && row.entry.kind !== "blocked")) return null;
				return { text: this.rowLabel(row) };
			},
		});
		this.unsubscribe = this.model.subscribe(() => this.remember());
		this.update(snapshot);
		this.configureMenu();
	}

	update(snapshot: TreeSnapshot) {
		if (this.disposed) return;
		const labelsChanged = snapshot.labels !== this.snapshot.labels;
		const sourceChanged = snapshot.scope !== this.snapshot.scope || snapshot.source !== this.snapshot.source;
		const filterChanged = snapshot.filter !== this.snapshot.filter;
		if (snapshot.selected !== this.snapshot.selected) this.revealPath = snapshot.selected;
		this.snapshot = snapshot;
		this.rows = new Map(snapshot.rows.map((row) => [treeModelPath(row), row]));
		const paths = [...this.rows.keys()];
		this.order = new Map(paths.map((path, index) => [path, index]));
		const pathsChanged = paths.length !== this.paths.length || paths.some((path, index) => path !== this.paths[index]);
		if (sourceChanged || pathsChanged || filterChanged) {
			this.projectionVersion++;
			if (this.clipboard) {
				this.clipboard.dispose();
				this.clipboard = undefined;
				snapshot.onCopyStatus?.("idle");
			}
		}
		this.syncing = true;
		try {
			if (pathsChanged) {
				this.paths = paths;
				this.model.resetPaths(paths, {
					initialExpandedPaths: snapshot.expanded.filter(Boolean).map((path) => `${path}/`),
				});
				this.model.setIcons({
					set: "minimal",
					colored: false,
					byFileName: Object.fromEntries(
						[...this.rows].flatMap(([path, row]) =>
							row.kind === "entry" && row.entry.kind === "blocked"
								? [[path.slice(path.lastIndexOf("/") + 1), "file-tree-icon-lock"]]
								: [],
						),
					),
				});
			} else if (!this.model.isSearchOpen()) {
				for (const [path, row] of this.rows) {
					if (row.kind !== "entry" || row.entry.kind !== "directory") continue;
					const item = this.model.getItem(path);
					if (!item || !("expand" in item)) continue;
					if (snapshot.expanded.includes(row.entry.path)) item.expand();
					else item.collapse();
				}
			}
			for (const path of this.model.getSelectedPaths()) {
				if (path !== snapshot.selected) this.model.getItem(path)?.deselect();
			}
			if (snapshot.selected) this.model.getItem(snapshot.selected)?.select();
			if (this.restorePosition && this.memory.activePath) this.model.focusPath(this.memory.activePath);
			this.model.setSearch(snapshot.filter || null);
		} finally {
			this.syncing = false;
		}
		const noMatches =
			!!snapshot.filter &&
			!snapshot.rows.some((row) => row.kind === "pending" || row.kind === "failed") &&
			!this.model.getSearchMatchingPaths().some((path) => this.rows.get(path)?.kind === "entry");
		if (noMatches !== this.noMatches) {
			this.noMatches = noMatches;
			snapshot.onNoMatches?.(noMatches);
		}
		if (labelsChanged && this.host) this.model.render({ fileTreeContainer: this.host });
		this.refreshPresentation();
		if (this.revealPath && this.rows.has(this.revealPath)) {
			this.restorePosition = false;
			this.model.scrollToPath(this.revealPath, { focus: false, offset: "nearest" });
			this.revealPath = undefined;
		}
	}

	mount(host: HTMLElement) {
		if (this.disposed) return;
		if (this.host) {
			this.detach?.();
			this.model.unmount();
		}
		this.host = host;
		this.model.render({ fileTreeContainer: host });
		const shadow = host.shadowRoot;
		if (!shadow) return;
		const observer = new MutationObserver(() => this.refreshPresentation());
		observer.observe(shadow, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-item-path", "aria-label", "data-visible"],
		});
		const click = (event: Event) => {
			const path = this.eventPath(event);
			if (path === undefined) return;
			const row = this.rows.get(path);
			if (!row) return;
			if (event.type === "dblclick" && (row.kind !== "entry" || row.entry.kind !== "file")) return;
			this.restorePosition = false;
			if (row.kind === "entry" && row.entry.kind === "directory") return;
			if (row.kind !== "entry" || row.entry.kind === "blocked") {
				event.preventDefault();
				event.stopPropagation();
				this.model.focusPath(path);
			}
			this.activate(path, event.type === "dblclick");
		};
		const keydown = (event: Event) => {
			if (!(event instanceof KeyboardEvent)) return;
			if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
			const path = this.eventPath(event);
			if (!path || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			event.stopPropagation();
			this.restorePosition = false;
			const item = this.model.getItem(path);
			if (item && "toggle" in item) item.toggle();
			else this.activate(path, event.key === "Enter");
		};
		const scroll = (event: Event) => {
			if (!(event.target instanceof HTMLElement) || !event.target.dataset.fileTreeVirtualizedScroll) return;
			if (!this.restorePosition) this.memory.scrollTop = event.target.scrollTop;
		};
		const actionTarget = (event: Event) => {
			const path = this.eventPath(event);
			if (!path) return;
			this.actionPath = path;
			this.refreshPresentation();
		};
		shadow.addEventListener("click", click, true);
		shadow.addEventListener("dblclick", click, true);
		shadow.addEventListener("keydown", keydown, true);
		shadow.addEventListener("scroll", scroll, true);
		shadow.addEventListener("pointerover", actionTarget, true);
		shadow.addEventListener("focusin", actionTarget, true);
		this.detach = () => {
			observer.disconnect();
			shadow.removeEventListener("click", click, true);
			shadow.removeEventListener("dblclick", click, true);
			shadow.removeEventListener("keydown", keydown, true);
			shadow.removeEventListener("scroll", scroll, true);
			shadow.removeEventListener("pointerover", actionTarget, true);
			shadow.removeEventListener("focusin", actionTarget, true);
			this.host = undefined;
		};
		this.refreshPresentation();
	}

	activate(path: string, pinned = false) {
		if (this.disposed) return;
		const row = this.rows.get(path);
		if (!row || (row.kind === "entry" && row.entry.kind !== "file") || row.kind === "pending" || row.kind === "empty")
			return;
		this.snapshot.onActivate(row, pinned);
	}

	/** Actions capture the current authorized projection, not merely a reusable filename. */
	contextActions(path: string): TreeContextAction[] {
		const row = this.rows.get(path);
		if (this.disposed || row?.kind !== "entry" || row.entry.kind === "blocked") return [];
		const { scope, source } = this.snapshot;
		const version = this.projectionVersion;
		const current = () => {
			const next = this.rows.get(path);
			return !this.disposed &&
				version === this.projectionVersion &&
				scope === this.snapshot.scope &&
				source === this.snapshot.source &&
				next?.kind === "entry" &&
				next.entry.kind === row.entry.kind
				? next
				: undefined;
		};
		const actions: TreeContextAction[] = [
			{
				id: "copy",
				label: this.snapshot.labels["tree.copyPath"],
				restoreFocus: true,
				run: () => {
					const target = current();
					if (!target) return;
					this.clipboard?.dispose();
					this.clipboard = new ClipboardFeedback((status) => {
						if (current()) this.snapshot.onCopyStatus?.(status);
					});
					this.clipboard.copy(target.entry.path);
				},
			},
		];
		if (row.entry.kind === "file" && this.snapshot.onPreview) {
			actions.push({
				id: "preview",
				label: this.snapshot.labels["view.preview"],
				restoreFocus: false,
				run: () => {
					const target = current();
					if (target) this.snapshot.onPreview?.(target);
				},
			});
		}
		return actions;
	}

	dispose() {
		if (this.disposed) return;
		const scroll = this.host?.shadowRoot?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]');
		if (scroll && !this.restorePosition) this.memory.scrollTop = scroll.scrollTop;
		this.disposed = true;
		this.clipboard?.dispose();
		this.detach?.();
		this.unsubscribe();
		this.model.cleanUp();
	}

	private configureMenu() {
		this.model.setComposition({
			contextMenu: {
				enabled: true,
				triggerMode: "both",
				buttonVisibility: "when-needed",
				render: (item, context) => {
					const actions = this.contextActions(item.path);
					if (actions.length === 0) {
						context.close();
						return null;
					}
					const menu = document.createElement("div");
					menu.className = "pierre-file-tree-menu ui-menu-surface";
					menu.setAttribute("aria-label", this.snapshot.labels["tree.actions"]);
					menu.setAttribute("role", "menu");
					for (const action of actions) {
						const button = document.createElement("button");
						button.className = "ui-menu-row";
						button.type = "button";
						button.setAttribute("role", "menuitem");
						button.textContent = action.label;
						button.addEventListener("click", () => {
							context.close({ restoreFocus: action.restoreFocus });
							action.run();
						});
						menu.append(button);
					}
					menu.addEventListener("keydown", (event) => {
						if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
						const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
						const active = document.activeElement;
						const current = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
						const next =
							event.key === "ArrowDown"
								? (current + 1) % buttons.length
								: event.key === "ArrowUp"
									? (current - 1 + buttons.length) % buttons.length
									: event.key === "Home"
										? 0
										: event.key === "End"
											? buttons.length - 1
											: undefined;
						if (next === undefined) return;
						event.preventDefault();
						event.stopPropagation();
						buttons[next]?.focus();
					});
					return menu;
				},
			},
		});
	}

	private remember() {
		if (this.syncing || this.disposed) return;
		// Search is a projection of already loaded pages, not permission to fetch
		// another directory. Its temporary expansion never changes loader state.
		if (this.model.isSearchOpen()) {
			if (!this.restorePosition) this.memory.activePath = this.model.getFocusedPath() ?? undefined;
			return;
		}
		const expanded = new Set(this.snapshot.expanded);
		let limited = false;
		this.syncing = true;
		try {
			for (const [path, row] of this.rows) {
				if (row.kind !== "entry" || row.entry.kind !== "directory") continue;
				const item = this.model.getItem(path);
				if (!item || !("expand" in item)) continue;
				if (!item.isExpanded()) expanded.delete(row.entry.path);
				else if (!expanded.has(row.entry.path)) {
					if (expanded.size >= FILE_TREE_EXPANSION_LIMIT) {
						item.collapse();
						limited = true;
					} else expanded.add(row.entry.path);
				}
			}
		} finally {
			this.syncing = false;
		}
		const paths = [...expanded];
		if (paths.length !== this.snapshot.expanded.length || paths.some((path, i) => path !== this.snapshot.expanded[i])) {
			this.memory.expanded = paths;
			this.snapshot = { ...this.snapshot, expanded: paths };
			this.snapshot.onExpanded(paths);
		}
		this.snapshot.onLimit(limited);
		if (!this.restorePosition) this.memory.activePath = this.model.getFocusedPath() ?? undefined;
	}

	private rowLabel(row: FileTreeRow) {
		if (row.kind === "entry") return row.entry.name;
		return this.snapshot.labels[row.kind === "pending" ? "loading" : row.kind === "failed" ? "retry" : row.kind];
	}

	private eventPath(event: Event) {
		for (const element of event.composedPath()) {
			if (element instanceof HTMLElement && element.dataset.type === "item") return element.dataset.itemPath;
		}
		return undefined;
	}

	private refreshPresentation() {
		const shadow = this.host?.shadowRoot;
		if (!shadow) return;
		const tree = shadow.querySelector('[role="tree"]');
		if (tree?.getAttribute("aria-label") !== this.snapshot.label) tree?.setAttribute("aria-label", this.snapshot.label);
		for (const element of shadow.querySelectorAll<HTMLElement>('[data-type="item"]')) {
			const row = this.rows.get(element.dataset.itemPath ?? "");
			if (!row) continue;
			const kind = row.kind === "entry" ? row.entry.kind : row.kind;
			const label = this.rowLabel(row);
			element.dataset.hipiKind = kind;
			element.dataset.path = row.kind === "entry" ? row.entry.path : row.path;
			element.setAttribute("aria-disabled", String(kind === "blocked" || kind === "pending" || kind === "empty"));
			if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
			const lane = element.querySelector<HTMLElement>('[data-item-section="action"]');
			if (lane) lane.style.visibility = kind === "file" || kind === "directory" ? "" : "hidden";
		}
		const trigger = shadow.querySelector<HTMLButtonElement>('[data-type="context-menu-trigger"]');
		if (trigger) {
			if (trigger.getAttribute("aria-label") !== this.snapshot.labels["tree.actions"])
				trigger.setAttribute("aria-label", this.snapshot.labels["tree.actions"]);
			const row = this.rows.get(this.actionPath ?? this.model.getFocusedPath() ?? "");
			trigger.disabled = row?.kind !== "entry" || row.entry.kind === "blocked";
			trigger.style.visibility = trigger.disabled ? "hidden" : "";
		}
		if (this.restorePosition && !this.snapshot.rows.some((row) => row.kind === "pending")) {
			const scroll = shadow.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]');
			const list = shadow.querySelector<HTMLElement>('[data-file-tree-virtualized-list="true"]');
			// A model reset schedules Pierre's DOM update. Restoring into the old
			// loading row would clamp a remembered scroll offset to zero.
			if (
				scroll &&
				list &&
				Number.parseFloat(list.style.height) >= this.model.getVisibleCount() * FILE_TREE_ROW_HEIGHT
			) {
				scroll.scrollTop = this.memory.scrollTop;
				this.restorePosition = false;
			}
		}
	}
}
