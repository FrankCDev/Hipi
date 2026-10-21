import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { FileSplitView, fileTreeLayout } from "../src/features/files/file-split-view.tsx";
import { FILE_TREE_ROW_HEIGHT, flattenFileTree, visibleDirectories } from "../src/features/files/file-tree-model.ts";

vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));

test("independent tree width clamps to 200px and 60 percent without assuming viewport width", () => {
	for (const available of [500, 640, 1200, 1440.5]) {
		for (const desired of [-1, 200, 250, 10000, NaN]) {
			const layout = fileTreeLayout(available, desired);
			assert.equal(layout.overlay, false);
			assert.ok(layout.width >= 200 && layout.width <= Math.floor(available * 0.6));
		}
	}
	assert.equal(fileTreeLayout(320, 240).overlay, true);
	assert.equal(FILE_TREE_ROW_HEIGHT, 28);
});

test("full-height content precedes the independently controlled right tree and hiding removes only tree presentation", () => {
	const render = (treeOpen: boolean) =>
		renderToStaticMarkup(
			<FileSplitView
				content={<div>Actual document</div>}
				tree={<div>Authorized tree</div>}
				treeOpen={treeOpen}
				width={240}
				onResize={() => {}}
				onCollapse={() => {}}
			/>,
		);
	const open = render(true);
	assert.ok(open.indexOf("Actual document") < open.indexOf("Authorized tree"));
	assert.match(open, /aria-label="File tree width"/);
	assert.match(open, /aria-valuemin="200"/);
	assert.match(open, /aria-valuemax="384"/);
	assert.match(open, /aria-valuenow="240"/);
	assert.match(open, /aria-orientation="vertical"/);
	const hidden = render(false);
	assert.match(hidden, /Actual document/);
	assert.doesNotMatch(hidden, /Authorized tree|file-tree-resizer|file-tree-pane/);
});

test("multiple expanded siblings are flattened without losing descendants when another branch opens", () => {
	const expanded = ["", "src", "src/nested", "docs"];
	const results = new Map([
		[
			"",
			{
				pending: false,
				failed: false,
				data: {
					entries: [
						{ name: "src", path: "src", kind: "directory" as const },
						{ name: "docs", path: "docs", kind: "directory" as const },
					],
					nextCursor: null,
				},
			},
		],
		[
			"src",
			{
				pending: false,
				failed: false,
				data: { entries: [{ name: "nested", path: "src/nested", kind: "directory" as const }], nextCursor: null },
			},
		],
		[
			"src/nested",
			{
				pending: false,
				failed: false,
				data: { entries: [{ name: "a.ts", path: "src/nested/a.ts", kind: "file" as const }], nextCursor: null },
			},
		],
		[
			"docs",
			{
				pending: false,
				failed: false,
				data: { entries: [{ name: "readme.md", path: "docs/readme.md", kind: "file" as const }], nextCursor: null },
			},
		],
	]);
	assert.deepEqual(
		flattenFileTree(expanded, results).map((row) => [row.id, row.depth]),
		[
			["src", 0],
			["src/nested", 1],
			["src/nested/a.ts", 2],
			["docs", 0],
			["docs/readme.md", 1],
		],
	);
	assert.deepEqual(visibleDirectories(["", "src/nested", "docs"]), ["", "docs"]);
	assert.deepEqual(
		flattenFileTree(["", "src/nested", "docs"], results).map((row) => row.id),
		["src", "docs", "docs/readme.md"],
	);
});

test("automatic boundaries, blocked resources and incomplete directory replies remain explicit rows", () => {
	const rows = flattenFileTree(
		["", "loading", "failed", "empty"],
		new Map([
			[
				"",
				{
					pending: false,
					failed: false,
					before: true,
					after: true,
					data: {
						entries: [
							{ name: "blocked", path: "blocked", kind: "blocked" },
							{ name: "loading", path: "loading", kind: "directory" },
							{ name: "failed", path: "failed", kind: "directory" },
							{ name: "empty", path: "empty", kind: "directory" },
						],
						nextCursor: "page3",
					},
				},
			],
			["loading", { pending: true, failed: false }],
			["failed", { pending: false, failed: true }],
			["empty", { pending: false, failed: false, data: { entries: [], nextCursor: null } }],
		]),
	);
	assert.deepEqual(
		rows.map((row) => row.kind),
		["boundary-before", "entry", "entry", "pending", "entry", "failed", "entry", "empty", "boundary-after"],
	);
	assert.equal(rows[1]?.kind === "entry" && rows[1].entry.kind, "blocked");
});
