import assert from "node:assert/strict";
import { preloadFileTree } from "@pierre/trees";
import { test, vi } from "vitest";
import { fileLabels } from "../src/features/files/file-labels.ts";
import { FileTreeAdapter } from "../src/features/files/file-tree-adapter.ts";
import {
	FILE_TREE_EXPANSION_LIMIT,
	type FileTreeMemory,
	type FileTreeRow,
	pageFileTree,
	revealFileTreeSelection,
	treeModelPath,
	treeSelectedPath,
	visibleDirectories,
} from "../src/features/files/file-tree-model.ts";

function entry(path: string, kind: "file" | "directory" | "blocked" = "file"): FileTreeRow {
	return {
		id: path,
		kind: "entry",
		entry: { name: path.split("/").at(-1) ?? path, path, kind },
		depth: path.split("/").length - 1,
		parent: path.slice(0, Math.max(0, path.lastIndexOf("/"))),
		...(kind === "directory" ? { expanded: false } : {}),
	};
}
function fixture(rows: FileTreeRow[], expanded = [""], memory?: FileTreeMemory) {
	const state = memory ?? { expanded, cursors: {}, scrollTop: 0 };
	const snapshot = {
		scope: "workspace:root",
		source: {},
		rows,
		expanded,
		label: "Authorized root",
		labels: fileLabels("en"),
		onExpanded: vi.fn(),
		onLimit: vi.fn(),
		onActivate: vi.fn(),
	};
	return { adapter: new FileTreeAdapter(state, snapshot), snapshot, memory: state };
}

test("model paths distinguish directories, blocked names and non-resource pagination rows", () => {
	const values: FileTreeRow[] = [
		entry("src", "directory"),
		entry("src/next.ts"),
		entry("src/:hipi-state:next", "blocked"),
		entry("src/:hipi-blocked:x", "blocked"),
		entry("src/\ud800", "blocked"),
		{ id: "src:next", kind: "next", path: "src", depth: 1 },
		{ id: "src:pending", kind: "pending", path: "src", depth: 1 },
	];
	const paths = values.map(treeModelPath);
	assert.equal(new Set(paths).size, values.length);
	assert.equal(paths[0], "src/");
	assert.equal(paths[1], "src/next.ts");
	assert.equal(paths[5], "src/:hipi-state:next");
});

test("selected file identity must match both workspace and root, never root alone", () => {
	const root = { workspaceId: "one", rootId: "root", writable: true };
	assert.equal(treeSelectedPath(root, { workspaceId: "two", rootId: "root", path: "a.ts" }), undefined);
	assert.equal(treeSelectedPath(root, { workspaceId: "one", rootId: "other", path: "a.ts" }), undefined);
	assert.equal(treeSelectedPath(root, { workspaceId: "one", rootId: "root", path: "a.ts" }), "a.ts");
});

test("selected-path reveal consumes only verified loaded ancestors and never exceeds the query budget", () => {
	const original = [""];
	assert.equal(revealFileTreeSelection(original, [], "unknown/deep/file.ts").expanded, original);
	const first = revealFileTreeSelection(original, [entry("src", "directory")], "src/nested/file.ts");
	assert.deepEqual(first.expanded, ["", "src"]);
	const next = revealFileTreeSelection(
		first.expanded,
		[entry("src", "directory"), entry("src/nested", "directory")],
		"src/nested/file.ts",
	);
	assert.deepEqual(next.expanded, ["", "src", "src/nested"]);
	let expanded = [""];
	const rows = Array.from({ length: FILE_TREE_EXPANSION_LIMIT + 20 }, (_, index) =>
		entry(`folder-${index}`, "directory"),
	);
	for (let index = 0; index < rows.length; index++) {
		const reveal = revealFileTreeSelection(expanded, rows, `folder-${index}/file.ts`);
		expanded = reveal.expanded;
		assert.ok(expanded.length <= FILE_TREE_EXPANSION_LIMIT);
		assert.ok(visibleDirectories(expanded).length <= FILE_TREE_EXPANSION_LIMIT);
		assert.equal(reveal.limited, index >= FILE_TREE_EXPANSION_LIMIT - 1);
	}
	assert.deepEqual(expanded, ["", ...rows.slice(0, FILE_TREE_EXPANSION_LIMIT - 1).map((row) => row.id)]);
});

test("public Pierre directory handles preserve multiple expanded siblings and remembered hidden descendants", () => {
	const { adapter, snapshot, memory } = fixture(
		[entry("src", "directory"), entry("src/nested", "directory"), entry("docs", "directory")],
		["", "src", "src/nested"],
	);
	const docs = adapter.model.getItem("docs/");
	const src = adapter.model.getItem("src/");
	assert.ok(docs && "expand" in docs && src && "collapse" in src);
	docs.expand();
	assert.deepEqual(memory.expanded, ["", "src", "src/nested", "docs"]);
	src.collapse();
	assert.deepEqual(memory.expanded, ["", "src/nested", "docs"]);
	assert.equal(snapshot.onExpanded.mock.calls.length, 2);
	adapter.dispose();
});

test("expansion limit is enforced through public handles without losing existing expanded folders", () => {
	const rows = Array.from({ length: FILE_TREE_EXPANSION_LIMIT }, (_, index) => entry(`folder-${index}`, "directory"));
	const expanded = ["", ...rows.slice(0, -1).map((row) => (row.kind === "entry" ? row.entry.path : ""))];
	const { adapter, snapshot, memory } = fixture(rows, expanded);
	const last = adapter.model.getItem(`folder-${FILE_TREE_EXPANSION_LIMIT - 1}/`);
	assert.ok(last && "expand" in last);
	last.expand();
	assert.equal(last.isExpanded(), false);
	assert.deepEqual(memory.expanded, expanded);
	assert.equal(snapshot.onLimit.mock.lastCall?.[0], true);
	adapter.dispose();
});

test("activation forwards only current real files and explicit paging/retry controls", () => {
	const blocked = entry(":hipi-state:next", "blocked");
	const next: FileTreeRow = { id: ":next", kind: "next", path: "", depth: 0 };
	const pending: FileTreeRow = { id: ":pending", kind: "pending", path: "", depth: 0 };
	const { adapter, snapshot } = fixture([entry("a.ts"), blocked, next, pending]);
	adapter.activate("a.ts");
	adapter.activate("a.ts", true);
	adapter.activate(treeModelPath(blocked));
	adapter.activate(treeModelPath(pending));
	adapter.activate("unknown.ts");
	adapter.activate(treeModelPath(next));
	assert.deepEqual(
		snapshot.onActivate.mock.calls.map(([row, pinned]) => [row.kind, pinned]),
		[
			["entry", false],
			["entry", true],
			["next", false],
		],
	);
	const onActivate = vi.fn();
	adapter.update({ ...snapshot, rows: [entry("b.ts")], onActivate });
	adapter.activate("a.ts", true);
	adapter.activate(treeModelPath(next));
	assert.equal(onActivate.mock.calls.length, 0, "Old page callbacks cannot open or page a newer projection");
	adapter.activate("b.ts", true);
	assert.equal(onActivate.mock.calls.length, 1);
	adapter.dispose();
	adapter.activate("b.ts");
	assert.equal(onActivate.mock.calls.length, 1, "Disposed roots cannot forward callbacks");
});

test("page navigation preserves unrelated siblings while pruning replaced descendants and exact cursor history", () => {
	const expanded = ["", "src", "src/nested", "docs", "docs/nested"];
	const first = pageFileTree(expanded, { docs: [undefined, "docs-two"] }, "src", "next", "src-two");
	assert.deepEqual(first.expanded, ["", "src", "docs", "docs/nested"]);
	assert.deepEqual(first.cursors, { docs: [undefined, "docs-two"], src: [undefined, "src-two"] });
	const back = pageFileTree(first.expanded, first.cursors, "src", "previous");
	assert.deepEqual(back.cursors.src, [undefined]);
	assert.deepEqual(pageFileTree(expanded, {}, "", "next", "root-two").expanded, [""]);
});

test("selection restoration and model reset retain exact focus; cleanup detaches subscriptions idempotently", () => {
	const memory: FileTreeMemory = { expanded: [""], cursors: {}, scrollTop: 280, activePath: "b.ts" };
	const { adapter, snapshot } = fixture([entry("a.ts"), entry("b.ts")], [""], memory);
	assert.equal(adapter.model.getFocusedPath(), "b.ts");
	adapter.update({ ...snapshot, rows: [entry("a.ts"), entry("b.ts"), entry("c.ts")], selected: "b.ts" });
	assert.equal(adapter.model.getFocusedPath(), "b.ts");
	assert.deepEqual(adapter.model.getSelectedPaths(), ["b.ts"]);
	const before = snapshot.onExpanded.mock.calls.length;
	adapter.dispose();
	adapter.dispose();
	adapter.update({ ...snapshot, rows: [entry("src", "directory")] });
	assert.equal(snapshot.onExpanded.mock.calls.length, before);
	assert.equal(memory.scrollTop, 280);
});

test("public search filters only loaded pages without requesting or persisting temporary expansion", () => {
	const { adapter, snapshot, memory } = fixture(
		[entry("src", "directory"), entry("src/alpha.ts"), entry("docs", "directory"), entry("docs/beta.md")],
		["", "src", "docs"],
	);
	adapter.update({ ...snapshot, filter: "alpha" });
	assert.ok(adapter.model.getSearchMatchingPaths().includes("src/alpha.ts"));
	assert.ok(!adapter.model.getSearchMatchingPaths().includes("docs/beta.md"));
	assert.equal(snapshot.onExpanded.mock.calls.length, 0);
	assert.deepEqual(memory.expanded, ["", "src", "docs"]);
	adapter.model.focusNextSearchMatch();
	assert.equal(snapshot.onExpanded.mock.calls.length, 0);
	adapter.update({ ...snapshot, filter: "" });
	assert.equal(adapter.model.isSearchOpen(), false);
	assert.equal(adapter.model.getVisibleCount(), 4);
	assert.deepEqual(memory.expanded, ["", "src", "docs"]);
	adapter.dispose();
});

test("context actions use the public visible trigger and only copy exact authorized relative paths", async () => {
	const writeText = vi.fn(async (_text: string) => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const { adapter, snapshot } = fixture([
		entry("src", "directory"),
		entry("src/中文 name.ts"),
		entry("blocked", "blocked"),
	]);
	const onPreview = vi.fn();
	const onCopyStatus = vi.fn();
	try {
		adapter.update({ ...snapshot, onPreview, onCopyStatus, expanded: ["", "src"] });
		assert.equal(adapter.model.getComposition()?.contextMenu?.triggerMode, "both");
		assert.equal(adapter.model.getComposition()?.contextMenu?.buttonVisibility, "when-needed");
		const projection = preloadFileTree({
			paths: ["src/", "src/中文 name.ts"],
			initialExpansion: "open",
			composition: adapter.model.getComposition(),
		});
		assert.doesNotMatch(projection.shadowHtml, /<span[^>]+data-item-action-affordance="decorative"/);
		assert.equal((projection.shadowHtml.match(/<button[^>]+data-type="context-menu-trigger"/g) ?? []).length, 1);
		const actions = adapter.contextActions("src/中文 name.ts");
		assert.deepEqual(
			actions.map((action) => action.id),
			["copy", "preview"],
		);
		actions[0]?.run();
		assert.deepEqual(writeText.mock.calls, [["src/中文 name.ts"]]);
		assert.equal(onCopyStatus.mock.lastCall?.[0], "copying");
		await vi.waitFor(() => assert.equal(onCopyStatus.mock.lastCall?.[0], "copied"));
		actions[1]?.run();
		assert.equal(onPreview.mock.calls[0]?.[0].entry.path, "src/中文 name.ts");
		const folder = adapter.contextActions("src/");
		assert.deepEqual(
			folder.map((action) => action.id),
			["copy"],
		);
		folder[0]?.run();
		assert.equal(writeText.mock.lastCall?.[0], "src", "Never copy Pierre's directory slash or an absolute root");
		assert.deepEqual(adapter.contextActions(treeModelPath(entry("blocked", "blocked"))), []);
		assert.deepEqual(adapter.contextActions(":hipi-state:next"), []);
	} finally {
		adapter.dispose();
		vi.unstubAllGlobals();
	}
});

test("context callbacks reject stale pages, scope changes, source changes and disposal", () => {
	const writeText = vi.fn(async (_text: string) => {});
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	const { adapter, snapshot } = fixture([entry("a.ts")]);
	const onPreview = vi.fn();
	try {
		adapter.update({ ...snapshot, onPreview });
		const original = adapter.contextActions("a.ts");
		adapter.update({ ...snapshot, rows: [entry("b.ts")], onPreview });
		for (const action of original) action.run();
		adapter.update({ ...snapshot, onPreview });
		for (const action of original) action.run();
		const beforeScopeChange = adapter.contextActions("a.ts");
		adapter.update({ ...snapshot, scope: "different-workspace:root", onPreview });
		for (const action of beforeScopeChange) action.run();
		const beforeSourceChange = adapter.contextActions("a.ts");
		const changedSource = {};
		adapter.update({ ...snapshot, source: changedSource, onPreview });
		for (const action of beforeSourceChange) action.run();
		const beforeFilterChange = adapter.contextActions("a.ts");
		adapter.update({ ...snapshot, source: changedSource, filter: "different file", onPreview });
		for (const action of beforeFilterChange) action.run();
		const beforeDisposal = adapter.contextActions("a.ts");
		adapter.dispose();
		for (const action of beforeDisposal) action.run();
		assert.equal(writeText.mock.calls.length, 0);
		assert.equal(onPreview.mock.calls.length, 0);
	} finally {
		adapter.dispose();
		vi.unstubAllGlobals();
	}
});

test("clipboard failures report feedback while late completion cannot label a replacement source copied", async () => {
	const { adapter, snapshot } = fixture([entry("a.ts")]);
	const onCopyStatus = vi.fn();
	let complete: (() => void) | undefined;
	vi.stubGlobal("navigator", {
		clipboard: {
			writeText: vi.fn(async () => {
				throw new Error("Clipboard denied");
			}),
		},
	});
	try {
		adapter.update({ ...snapshot, onCopyStatus });
		adapter.contextActions("a.ts")[0]?.run();
		await vi.waitFor(() => assert.equal(onCopyStatus.mock.lastCall?.[0], "failed"));
		vi.stubGlobal("navigator", {
			clipboard: {
				writeText: () =>
					new Promise<void>((resolve) => {
						complete = resolve;
					}),
			},
		});
		adapter.contextActions("a.ts")[0]?.run();
		assert.equal(onCopyStatus.mock.lastCall?.[0], "copying");
		adapter.update({ ...snapshot, source: {}, onCopyStatus });
		assert.equal(onCopyStatus.mock.lastCall?.[0], "idle");
		assert.ok(complete);
		complete();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(onCopyStatus.mock.lastCall?.[0], "idle");
	} finally {
		adapter.dispose();
		vi.unstubAllGlobals();
	}
});

test("no-match feedback follows the public search projection only after directory pages are loaded", () => {
	const onNoMatches = vi.fn();
	const { adapter, snapshot } = fixture([entry("alpha.ts")]);
	adapter.update({ ...snapshot, filter: "missing", onNoMatches });
	assert.equal(onNoMatches.mock.lastCall?.[0], true);
	adapter.update({
		...snapshot,
		filter: "missing",
		rows: [{ id: ":pending", kind: "pending", path: "", depth: 0 }],
		onNoMatches,
	});
	assert.equal(onNoMatches.mock.lastCall?.[0], false);
	adapter.update({
		...snapshot,
		filter: "missing",
		rows: [{ id: ":failed", kind: "failed", path: "", depth: 0 }],
		onNoMatches,
	});
	assert.equal(onNoMatches.mock.lastCall?.[0], false);
	adapter.update({ ...snapshot, filter: "missing", onNoMatches });
	assert.equal(onNoMatches.mock.lastCall?.[0], true);
	adapter.update({ ...snapshot, filter: "", onNoMatches });
	assert.equal(adapter.model.isSearchOpen(), false);
	assert.equal(onNoMatches.mock.lastCall?.[0], false);
	adapter.update({ ...snapshot, filter: "alpha", onNoMatches });
	assert.equal(adapter.model.getSearchMatchingPaths()[0], "alpha.ts");
	assert.equal(onNoMatches.mock.lastCall?.[0], false);
	assert.equal(snapshot.onExpanded.mock.calls.length, 0);
	adapter.dispose();
});

test("public engine server projection virtualizes ten thousand paths into a compact initial window", () => {
	const payload = preloadFileTree({
		paths: Array.from({ length: 10000 }, (_, index) => `file-${String(index).padStart(5, "0")}.ts`),
		initialExpansion: "closed",
		initialVisibleRowCount: 12,
		itemHeight: 28,
		overscan: 8,
		stickyFolders: true,
	});
	assert.match(payload.shadowHtml, /data-file-tree-virtualized-scroll="true"/);
	const renderedRows = (payload.shadowHtml.match(/role="treeitem"/g) ?? []).length;
	assert.ok(renderedRows > 0 && renderedRows <= 28, `Rendered ${renderedRows} rows rather than all 10,000`);
	assert.match(payload.outerStart, /--trees-item-height:28px/);
});
