import type { FileRoot, FileTarget } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { ClipboardStatus } from "../workbench/clipboard-feedback.ts";
import { fileLabels } from "./file-labels.ts";
import { FileTreeAdapter } from "./file-tree-adapter.ts";
import {
	type FileTreeMemory,
	type FileTreeRow,
	fileTarget,
	flattenFileTree,
	pageFileTree,
	revealFileTreeSelection,
	treeSelectedPath,
	visibleDirectories,
} from "./file-tree-model.ts";
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
	const cache = useQueryClient();
	const [expanded, setExpanded] = useState(memory.expanded);
	const [cursors, setCursors] = useState(memory.cursors);
	const [limited, setLimited] = useState(false);
	const [filter, setFilter] = useState("");
	const [noMatches, setNoMatches] = useState(false);
	const [copyStatus, setCopyStatus] = useState<ClipboardStatus>("idle");
	const filterInput = useRef<HTMLInputElement>(null);
	const mount = useRef<HTMLDivElement>(null);
	const adapter = useRef<FileTreeAdapter | undefined>(undefined);
	const directories = visibleDirectories(expanded);
	const queries = useQueries({
		queries: directories.map((path) => ({
			queryKey: ["files", root.workspaceId, root.rootId, path, cursors[path]?.at(-1)],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				files.list(fileTarget(root, path), cursors[path]?.at(-1), signal),
			gcTime: 0,
			retry: false,
		})),
	});
	const results = new Map(
		directories.map((path, index) => [
			path,
			{
				data: queries[index]?.data,
				pending: queries[index]?.isPending ?? true,
				failed: queries[index]?.isError ?? false,
			},
		]),
	);
	const rows = flattenFileTree(expanded, cursors, results);
	const selectedPath = treeSelectedPath(root, selected);
	const revealPath = useRef<string | undefined>(selectedPath);
	useEffect(() => {
		memory.expanded = expanded;
		memory.cursors = cursors;
	}, [memory, expanded, cursors]);
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
			void cache.invalidateQueries({ queryKey: ["files", root.workspaceId, root.rootId, row.path] });
		} else if (row.kind === "previous" || row.kind === "next") {
			revealPath.current = undefined;
			const next = pageFileTree(expanded, cursors, row.path, row.kind, results.get(row.path)?.data?.nextCursor);
			setExpanded(next.expanded);
			setCursors(next.cursors);
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
