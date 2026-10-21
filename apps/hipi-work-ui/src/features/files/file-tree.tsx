import type { FileRoot, FileTarget } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { ClipboardStatus } from "../workbench/conversation/markdown/clipboard-feedback.ts";
import { fileLabels } from "./file-labels.ts";
import { FileTreeAdapter } from "./file-tree-adapter.ts";
import {
	FILE_TREE_EXPANSION_LIMIT,
	type FileTreeMemory,
	type FileTreeRow,
	fileTarget,
	flattenFileTree,
	revealFileTreeSelection,
	treeSelectedPath,
	visibleDirectories,
} from "./file-tree-model.ts";
import { type DirectoryEdge, DirectoryWindow } from "./tree/directory-window.ts";
import "./pierre-file-tree.css";

export function FileTree({
	root,
	files,
	memory,
	selected,
	open,
	preview,
}: {
	root: FileRoot;
	files: FileClient;
	memory: FileTreeMemory;
	selected?: FileTarget;
	open: (target: FileTarget, writable: boolean, pinned: boolean) => void;
	preview?: (target: FileTarget) => void;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const [expanded, setExpanded] = useState(memory.expanded);
	const windows = useRef(new Map<string, DirectoryWindow>());
	const [, render] = useState(0);
	const [limited, setLimited] = useState(false);
	const [filter, setFilter] = useState("");
	const [noMatches, setNoMatches] = useState(false);
	const [copyStatus, setCopyStatus] = useState<ClipboardStatus>("idle");
	const filterInput = useRef<HTMLInputElement>(null);
	const mount = useRef<HTMLDivElement>(null);
	const adapter = useRef<FileTreeAdapter | undefined>(undefined);
	const directories = visibleDirectories(expanded);
	useEffect(() => {
		const retained = windows.current;
		return () => {
			for (const window of retained.values()) window.dispose();
			retained.clear();
		};
	}, []);
	useEffect(() => {
		const paths = new Set(visibleDirectories(expanded));
		for (const [path, window] of windows.current)
			if (!paths.has(path)) {
				window.dispose();
				windows.current.delete(path);
			}
	}, [expanded]);
	const demand = (
		path: string,
		edge: DirectoryEdge,
		protectedPaths: ReadonlySet<string> = new Set(),
		retry = false,
	) => {
		if (!directories.includes(path)) return;
		// Visible boundaries only: expanding many folders cannot enqueue a whole disk scan.
		if ([...windows.current.values()].filter((window) => window.snapshot().pending).length >= 4) return;
		let window = windows.current.get(path);
		if (!window) {
			memory.directories ??= new Map();
			window = new DirectoryWindow(
				files,
				fileTarget(root, path),
				() => {
					const current = windows.current.get(path);
					if (current && memory.directories) {
						memory.directories.delete(path);
						memory.directories.set(path, current.bookmark());
						const oldest = memory.directories.keys().next().value;
						if (oldest !== undefined && memory.directories.size > FILE_TREE_EXPANSION_LIMIT)
							memory.directories.delete(oldest);
					}
					render((value) => value + 1);
				},
				memory.directories.get(path),
			);
			windows.current.set(path, window);
		}
		void window.load(edge, protectedPaths, retry);
	};
	useEffect(() => {
		let active = true;
		let validating = false;
		const validate = async () => {
			if (validating) return;
			validating = true;
			try {
				for (const window of windows.current.values()) {
					if (!active) return;
					if (window.snapshot().pages.length) await window.validate();
				}
			} finally {
				validating = false;
			}
		};
		window.addEventListener("focus", validate);
		return () => {
			active = false;
			window.removeEventListener("focus", validate);
		};
	}, []);
	const results = new Map(
		directories.map((path) => {
			const state = windows.current.get(path)?.snapshot();
			return [
				path,
				{
					data: state?.pages.length
						? {
								entries: state.pages.flatMap((page) => page.data.entries),
								nextCursor: state.pages.at(-1)?.data.nextCursor ?? null,
							}
						: undefined,
					pending: !state || state.pending || (!state.failed && state.pages.length === 0),
					failed: state?.failed ?? false,
					before: state?.before,
					after: state?.after,
				},
			];
		}),
	);
	const rows = flattenFileTree(expanded, results);
	const selectedPath = treeSelectedPath(root, selected);
	const revealPath = useRef<string | undefined>(selectedPath);
	useEffect(() => {
		memory.expanded = expanded;
	}, [memory, expanded]);
	useEffect(() => {
		revealPath.current = selectedPath;
	}, [selectedPath]);
	useEffect(() => {
		if (!selectedPath || revealPath.current !== selectedPath) return;
		const next = revealFileTreeSelection(expanded, rows, selectedPath);
		if (next.expanded !== expanded) setExpanded(next.expanded);
		if (next.limited) setLimited(true);
		if (next.limited || rows.some((row) => row.kind === "entry" && row.entry.path === selectedPath))
			revealPath.current = undefined;
	}, [expanded, rows, selectedPath]);
	const activate = (row: FileTreeRow, pinned: boolean) => {
		if (row.kind === "entry") {
			if (row.entry.kind === "file") open(fileTarget(root, row.entry.path), root.writable, pinned);
		} else if (row.kind === "failed") {
			demand(row.path, "after", new Set(), true);
		}
	};
	const snapshot = {
		scope: JSON.stringify([root.workspaceId, root.rootId]),
		source: files,
		rows,
		expanded,
		selected: selectedPath,
		filter,
		label: root.displayName ?? l.root,
		labels: l,
		onExpanded: (paths: string[]) => {
			revealPath.current = undefined;
			setExpanded(paths);
		},
		onLimit: setLimited,
		onCopyStatus: setCopyStatus,
		onNoMatches: setNoMatches,
		onActivate: activate,
		onDemand: demand,
		onPreview: preview
			? (row: FileTreeRow) => {
					if (row.kind === "entry" && row.entry.kind === "file") preview(fileTarget(root, row.entry.path));
				}
			: undefined,
	};
	const snapshotRef = useRef(snapshot);
	useLayoutEffect(() => {
		snapshotRef.current = snapshot;
		adapter.current?.update(snapshot);
	});
	// Each keyed workspace/root owns one model. Strict Mode creates a fresh model
	// after cleanup instead of remounting an already disposed controller.
	useLayoutEffect(() => {
		const container = mount.current;
		if (!container) return;
		const host = document.createElement("file-tree-container");
		const instance = new FileTreeAdapter(memory, snapshotRef.current);
		container.append(host);
		instance.mount(host);
		adapter.current = instance;
		return () => {
			adapter.current = undefined;
			instance.dispose();
			host.remove();
		};
	}, [memory]);
	return (
		<>
			{limited && <output className="file-tree-limit">{l["tree.limit"]}</output>}
			<div className="pierre-file-tree-filter" data-tab-preview-pin-exempt="true">
				<input
					ref={filterInput}
					type="search"
					aria-label={l["tree.filter"]}
					title={l["tree.filterScope"]}
					placeholder={l["tree.filterPlaceholder"]}
					value={filter}
					onChange={(event) => setFilter(event.currentTarget.value)}
				/>
				{filter && (
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={l["tree.clearFilter"]}
						title={l["tree.clearFilter"]}
						onClick={() => {
							setFilter("");
							filterInput.current?.focus();
						}}
					>
						<X size={14} aria-hidden />
					</Button>
				)}
			</div>
			{noMatches && <output className="pierre-file-tree-feedback">{l["tree.noMatches"]}</output>}
			{copyStatus === "failed" ? (
				<p className="pierre-file-tree-feedback" role="alert">
					{l["tree.copyFailed"]}
				</p>
			) : (
				<output className="pierre-file-tree-feedback" aria-live="polite">
					{copyStatus === "copying" ? l["tree.copying"] : copyStatus === "copied" ? l["tree.copied"] : ""}
				</output>
			)}
			<div className="pierre-file-tree" ref={mount} data-file-tree-engine="pierre" data-tab-preview-pin-exempt="true" />
		</>
	);
}
