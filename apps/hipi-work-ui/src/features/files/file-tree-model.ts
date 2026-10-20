import type { FileEntry, FilePage, FileRoot, FileTarget } from "@hipi/work-runtime/files";

export const FILE_TREE_ROW_HEIGHT = 28;
export const FILE_TREE_EXPANSION_LIMIT = 64;
export type FileTreeMemory = {
	expanded: string[];
	cursors: Record<string, (string | undefined)[]>;
	scrollTop: number;
	activePath?: string;
};
export type DirectoryResult = { data?: FilePage; pending: boolean; failed: boolean };
export type FileTreeRow =
	| { id: string; kind: "entry"; entry: FileEntry; depth: number; parent: string; expanded?: boolean }
	| { id: string; kind: "pending" | "failed" | "empty" | "previous" | "next"; path: string; depth: number };

export function fileTarget(root: FileRoot, path: string): FileTarget {
	return { workspaceId: root.workspaceId, rootId: root.rootId, path };
}
/** Pierre directory identities include a trailing slash; runtime targets never do. */
export function treeModelPath(row: FileTreeRow): string {
	if (row.kind !== "entry") return `${row.path ? `${row.path}/` : ""}:hipi-state:${row.kind}`;
	if (row.entry.kind === "directory") return `${row.entry.path}/`;
	if (row.entry.kind === "file") return row.entry.path;
	// Blocked names are display-only. Encode UTF-16 code units, including lone
	// surrogates, rather than normalizing them into an actionable resource.
	const name = Array.from({ length: row.entry.name.length }, (_, index) =>
		row.entry.name.charCodeAt(index).toString(16).padStart(4, "0"),
	).join("");
	return `${row.parent ? `${row.parent}/` : ""}:hipi-blocked:${name}`;
}
export function treeSelectedPath(root: FileRoot, selected?: FileTarget): string | undefined {
	return selected?.workspaceId === root.workspaceId && selected.rootId === root.rootId ? selected.path : undefined;
}
/** Reveal only verified ancestors, one loaded page at a time, within the loader budget. */
export function revealFileTreeSelection(expanded: string[], rows: readonly FileTreeRow[], selected?: string) {
	if (!selected) return { expanded, limited: false };
	const directories = new Set(
		rows.flatMap((row) => (row.kind === "entry" && row.entry.kind === "directory" ? [row.entry.path] : [])),
	);
	const next = new Set(expanded);
	const parts = selected.split("/");
	for (let index = 1; index < parts.length; index++) {
		const path = parts.slice(0, index).join("/");
		if (!directories.has(path)) break;
		if (next.has(path)) continue;
		if (next.size >= FILE_TREE_EXPANSION_LIMIT)
			return { expanded: next.size === expanded.length ? expanded : [...next], limited: true };
		next.add(path);
	}
	return { expanded: next.size === expanded.length ? expanded : [...next], limited: false };
}
export function pageFileTree(
	expanded: readonly string[],
	cursors: FileTreeMemory["cursors"],
	path: string,
	direction: "previous" | "next",
	nextCursor?: string | null,
) {
	return {
		expanded: expanded.filter((item) => item === "" || item === path || (path !== "" && !item.startsWith(`${path}/`))),
		cursors: {
			...cursors,
			[path]:
				direction === "previous"
					? (cursors[path] ?? []).slice(0, -1)
					: [...(cursors[path] ?? [undefined]), nextCursor ?? undefined],
		},
	};
}
export function visibleDirectories(expanded: readonly string[]) {
	const paths = new Set(expanded);
	return expanded
		.filter((path) => {
			const parts = path.split("/");
			return path === "" || parts.slice(0, -1).every((_, index) => paths.has(parts.slice(0, index + 1).join("/")));
		})
		.slice(0, FILE_TREE_EXPANSION_LIMIT);
}
/** Only currently authorized, paginated directory replies are projected into rows. */
export function flattenFileTree(
	expanded: readonly string[],
	cursors: FileTreeMemory["cursors"],
	results: ReadonlyMap<string, DirectoryResult>,
): FileTreeRow[] {
	const rows: FileTreeRow[] = [];
	const paths = new Set(expanded);
	const visit = (path: string, depth: number) => {
		const result = results.get(path);
		if (!result || result.pending) rows.push({ id: `${path}:pending`, kind: "pending", path, depth });
		else if (result.failed) rows.push({ id: `${path}:failed`, kind: "failed", path, depth });
		else {
			if (result.data?.entries.length === 0) rows.push({ id: `${path}:empty`, kind: "empty", path, depth });
			for (const entry of result.data?.entries ?? []) {
				const isExpanded = entry.kind === "directory" && paths.has(entry.path);
				rows.push({
					id: entry.path,
					kind: "entry",
					entry,
					depth,
					parent: path,
					...(entry.kind === "directory" ? { expanded: isExpanded } : {}),
				});
				if (isExpanded) visit(entry.path, depth + 1);
			}
			if ((cursors[path]?.length ?? 0) > 1) rows.push({ id: `${path}:previous`, kind: "previous", path, depth });
			if (result.data?.nextCursor) rows.push({ id: `${path}:next`, kind: "next", path, depth });
		}
	};
	visit("", 0);
	return rows;
}
