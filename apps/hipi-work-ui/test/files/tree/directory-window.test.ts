import assert from "node:assert/strict";
import { FILE_LIMITS, type FilePage, FileServiceError } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { test, vi } from "vitest";
import { DIRECTORY_WINDOW_PAGES, DirectoryWindow } from "../../../src/features/files/tree/directory-window.ts";

const target = { workspaceId: "workspace", rootId: "authorized", path: "src" };
function fixture(list: FileClient["list"]) {
	const client: FileClient = {
		list,
		listRoots: async () => [],
		readText: async () => {
			throw new Error("Unexpected read");
		},
		saveText: async () => {
			throw new Error("Unexpected write");
		},
		preview: async () => {
			throw new Error("Unexpected preview");
		},
	};
	const changed = vi.fn();
	return { window: new DirectoryWindow(client, target, changed), changed };
}
function page(index: number, count = 7): FilePage {
	return {
		entries: Array.from({ length: FILE_LIMITS.page }, (_, offset) => ({
			name: `${index}-${offset}`,
			path: `src/${index}-${offset}`,
			kind: "file",
		})),
		nextCursor: index + 1 < count ? String(index + 1) : null,
	};
}

test("viewport demand traverses seven pages and returns to the beginning with at most three resident pages", async () => {
	const list = vi.fn<FileClient["list"]>(async (_target, cursor) => page(Number(cursor ?? 0)));
	const { window } = fixture(list);
	for (let index = 0; index < 7; index++) {
		await window.load("after");
		assert.equal(window.snapshot().pages.at(-1)?.index, index);
		assert.ok(window.snapshot().pages.length <= DIRECTORY_WINDOW_PAGES);
	}
	assert.equal(window.snapshot().after, false);
	assert.equal(window.snapshot().before, true);
	for (let index = 3; index >= 0; index--) {
		await window.load("before");
		assert.equal(window.snapshot().pages[0]?.index, index);
	}
	assert.equal(window.snapshot().before, false);
	assert.equal(window.snapshot().after, true);
	assert.ok(list.mock.calls.every(([value]) => value === target));
	window.dispose();
});

test("visible rows prevent eviction until scrolling releases them", async () => {
	const list = vi.fn<FileClient["list"]>(async (_target, cursor) => page(Number(cursor ?? 0)));
	const { window } = fixture(list);
	for (let index = 0; index < 3; index++) await window.load("after");
	await window.load("after", new Set(["src/0-2"]));
	assert.equal(list.mock.calls.length, 3);
	await window.load("after");
	assert.equal(window.snapshot().pages[0]?.index, 1);
	window.dispose();
});

test("directory mutation replaces a stale generation instead of joining old and new entries", async () => {
	let stale = false;
	const { window } = fixture(async (_target, cursor) => {
		if (stale && cursor) throw new FileServiceError("VERSION_CONFLICT");
		return stale
			? { entries: [{ name: "new", path: "src/new", kind: "file" }], nextCursor: null }
			: page(Number(cursor ?? 0));
	});
	await window.load("after");
	stale = true;
	await window.load("after");
	assert.deepEqual(
		window.snapshot().pages.flatMap((value) => value.data.entries.map((entry) => entry.path)),
		["src/new"],
	);
	assert.equal(window.snapshot().after, false);
	assert.equal(window.snapshot().failed, false);
	window.dispose();
});

test("empty intermediate pages remain traversable and repeated cursors stop rather than spin", async () => {
	const { window } = fixture(async (_target, cursor) => ({ entries: [], nextCursor: cursor ? cursor : "next" }));
	await window.load("after");
	assert.equal(window.snapshot().after, true);
	await window.load("after");
	assert.equal(window.snapshot().failed, true);
	const snapshot = window.snapshot();
	await window.load("after");
	assert.equal(window.snapshot(), snapshot);
	window.dispose();
});

test("revocation clears actionable metadata and retry is explicit", async () => {
	let denied = false;
	const { window } = fixture(async (_target, cursor) => {
		if (denied) throw new FileServiceError("UNAUTHORIZED");
		return page(Number(cursor ?? 0));
	});
	await window.load("after");
	denied = true;
	await window.load("after");
	assert.equal(window.snapshot().pages.length, 0);
	assert.equal(window.snapshot().failed, true);
	denied = false;
	await window.load("after", new Set(), true);
	assert.equal(window.snapshot().pages[0]?.index, 0);
	window.dispose();
});

test("single flight and disposal reject late replies without publication", async () => {
	let finish: (value: FilePage) => void = () => {};
	const list = vi.fn(
		() =>
			new Promise<FilePage>((resolve) => {
				finish = resolve;
			}),
	);
	const { window, changed } = fixture(list);
	const pending = window.load("after");
	await window.load("after");
	assert.equal(list.mock.calls.length, 1);
	window.dispose();
	const count = changed.mock.calls.length;
	finish(page(0));
	await pending;
	assert.equal(changed.mock.calls.length, count);
});

test("focus validation keeps a coherent window and resets changed metadata", async () => {
	let changed = false;
	const { window } = fixture(async (_target, cursor) =>
		changed ? { entries: [], nextCursor: null } : page(Number(cursor ?? 0)),
	);
	await window.load("after");
	await window.load("after");
	await window.validate();
	assert.equal(window.snapshot().pages.length, 2);
	changed = true;
	await window.validate();
	assert.equal(window.snapshot().pages.length, 1);
	assert.equal(window.snapshot().after, false);
	window.dispose();
});

test("returning to page zero detects a changed revision even though that request has no cursor", async () => {
	let changed = false;
	const { window } = fixture(async (_target, cursor) =>
		changed && !cursor
			? { entries: [{ name: "replacement", path: "src/replacement", kind: "file" }], nextCursor: "new-version" }
			: page(Number(cursor ?? 0)),
	);
	for (let index = 0; index < 4; index++) await window.load("after");
	changed = true;
	await window.load("before");
	assert.equal(window.snapshot().pages.length, 1);
	assert.equal(window.snapshot().pages[0]?.data.entries[0]?.name, "replacement");
	window.dispose();
});

test("presentation bookmarks reauthorize an evicted window and retain reverse reachability", async () => {
	const list: FileClient["list"] = async (_target, cursor) => page(Number(cursor ?? 0));
	const { window } = fixture(list);
	for (let index = 0; index < 6; index++) await window.load("after");
	const bookmark = window.bookmark();
	window.dispose();
	const client: FileClient = {
		list,
		listRoots: async () => [],
		readText: vi.fn(),
		saveText: vi.fn(),
		preview: vi.fn(),
	};
	const restored = new DirectoryWindow(client, target, () => {}, bookmark);
	assert.equal(restored.snapshot().pages.length, 0, "Remembered cursors are never remembered authority or bytes");
	await restored.load("after");
	assert.equal(restored.snapshot().pages[0]?.index, 3);
	await restored.load("before");
	assert.equal(restored.snapshot().pages[0]?.index, 2);
	restored.dispose();
});

test("stale-cursor recovery which is denied cannot leave old actionable rows", async () => {
	let fail = false;
	const { window } = fixture(async (_target, cursor) => {
		if (fail) throw new FileServiceError(cursor ? "VERSION_CONFLICT" : "UNAUTHORIZED");
		return page(Number(cursor ?? 0));
	});
	await window.load("after");
	fail = true;
	await window.load("after");
	assert.equal(window.snapshot().pages.length, 0);
	assert.equal(window.snapshot().failed, true);
	window.dispose();
});
