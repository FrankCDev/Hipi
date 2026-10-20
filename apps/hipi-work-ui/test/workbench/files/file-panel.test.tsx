import assert from "node:assert/strict";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { FileWorkspaceSession } from "../../../src/features/files/file-workspace-session.ts";
import { FilePanel } from "../../../src/features/workbench/files/panel.tsx";
import {
	FilePanelController,
	panelLayout,
	validPanelWidth,
} from "../../../src/features/workbench/files/panel-controller.ts";
import { filePanelLabels } from "../../../src/features/workbench/files/panel-labels.ts";
import type { BrowserStorage } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

function editor(session: FileWorkspaceSession) {
	const tab = session.snapshot().tabs.find((item) => item.id === session.snapshot().activeId);
	assert.ok(tab && tab.kind === "editor");
	return tab.editor;
}

const port = vi.hoisted(() => ({ files: undefined as FileClient | undefined }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useFiles: () => port }));
class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}
test("closed by default; validated preferences restore only for the verified store", () => {
	const storage = new MemoryStorage();
	const panel = new FilePanelController(new LocalState("one", storage));
	assert.equal(panel.snapshot().open, false);
	panel.setOpen(true);
	panel.resize(550, 1200);
	assert.deepEqual(new FilePanelController(new LocalState("one", storage)).snapshot(), {
		open: true,
		fullWidth: false,
		width: 640,
		ratio: 0.458333,
		storageFailed: false,
	});
	assert.equal(new FilePanelController(new LocalState("two", storage)).snapshot().open, false);
	assert.equal(new FilePanelController(new LocalState(undefined, storage)).snapshot().open, false);
	for (const width of ["NaN", "Infinity", "-1", "9999", "300", "420px", "420.5", " 420", "0420"]) {
		assert.equal(validPanelWidth(width), false);
		storage.setItem(
			"hipi.work.local.v1.one.value.file-panel.width",
			JSON.stringify({ version: 1, storeId: "one", kind: "value", key: "file-panel.width", value: width }),
		);
		assert.equal(new FilePanelController(new LocalState("one", storage)).snapshot().width, 640);
	}
});
test("resize bounds preserve conversation space and choose a dialog when there is not enough room", () => {
	for (const available of [0, 320, 672, NaN, Infinity]) assert.equal(panelLayout(available, 420).overlay, true);
	for (const available of [673, 673.2, 900, 1200, 2400]) {
		for (const desired of [-100, 320, 420, 10000, NaN]) {
			const layout = panelLayout(available, desired);
			assert.equal(layout.overlay, false);
			assert.ok(layout.width >= 320 && layout.width <= available - 353);
			assert.ok(available - layout.width - 1 >= 352);
		}
	}
});
test("drag updates remain in memory until committed and subscriptions clean up", () => {
	const local = new LocalState();
	const panel = new FilePanelController(local);
	let changes = 0;
	const unsubscribe = panel.subscribe(() => changes++);
	panel.resize(600, 1200, false);
	assert.equal(local.read("file-panel.width"), null);
	panel.resize(panel.snapshot().width, 1200);
	assert.equal(local.read("file-panel.ratio"), "0.500000");
	unsubscribe();
	panel.setOpen(true);
	assert.equal(changes, 2);
});
test("splitter thresholds collapse below 160px and fill only with less than 160px remaining", () => {
	const local = new LocalState();
	const panel = new FilePanelController(local);
	panel.setOpen(true);
	panel.resize(550, 1200);
	const ratio = panel.snapshot().ratio;
	panel.resizeFromSplitter(160, 1200);
	assert.equal(panel.snapshot().open, true);
	assert.equal(panel.snapshot().width, 320);
	panel.resize(550, 1200);
	panel.resizeFromSplitter(159.99, 1200);
	assert.equal(panel.snapshot().open, false);
	assert.equal(panel.snapshot().ratio, ratio);
	panel.setOpen(true);
	panel.resizeFromSplitter(1040, 1200);
	assert.equal(panel.snapshot().fullWidth, false);
	panel.resize(550, 1200);
	panel.resizeFromSplitter(1040.01, 1200);
	assert.equal(panel.snapshot().fullWidth, true);
	assert.equal(panel.snapshot().width, 550);
	assert.equal(panel.snapshot().ratio, ratio);
	assert.equal(local.read("file-panel.ratio"), "0.458333");
	panel.setOpen(false);
	panel.setOpen(true);
	assert.equal(panel.snapshot().fullWidth, false);
	assert.equal(panelLayout(1200, panel.snapshot().width, panel.snapshot().ratio).width, 550);
});
test("pointer overflow preserves the pre-gesture split; cancellation restores the complete presentation", () => {
	const local = new LocalState();
	const panel = new FilePanelController(local);
	panel.setOpen(true);
	panel.resize(560, 1200);
	const original = panel.snapshot();
	panel.beginResize();
	panel.resizeFromSplitter(800, 1200, false);
	panel.resizeFromSplitter(10000, 1200, false);
	assert.equal(panel.snapshot().fullWidth, true);
	assert.equal(panel.snapshot().ratio, original.ratio);
	panel.finishResize();
	assert.equal(local.read("file-panel.ratio"), "0.466667");
	panel.restoreSplit();
	panel.beginResize();
	panel.resizeFromSplitter(400, 1200, false);
	panel.resizeFromSplitter(-1000, 1200, false);
	assert.equal(panel.snapshot().open, false);
	assert.equal(panel.snapshot().ratio, original.ratio);
	panel.finishResize(true);
	assert.deepEqual(panel.snapshot(), original);
	for (const width of [NaN, Infinity, -Infinity]) panel.resizeFromSplitter(width, 1200);
	for (const available of [0, 600, NaN, Infinity]) panel.resizeFromSplitter(0, available);
	assert.deepEqual(panel.snapshot(), original);
});
test("storage denial or revoked lease leaves panel usable and reports failed persistence", () => {
	const storage = new MemoryStorage();
	storage.setItem = () => {
		throw new Error("denied");
	};
	const local = new LocalState("store", storage);
	const panel = new FilePanelController(local);
	panel.setOpen(true);
	assert.equal(panel.snapshot().open, true);
	assert.equal(panel.snapshot().storageFailed, true);
	local.deactivate();
	panel.resize(500, 1200);
	assert.equal(panel.snapshot().storageFailed, true);
});
function render(panel: FilePanelController, session?: FileWorkspaceSession, available: number | null = 1200) {
	const cache = new QueryClient();
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<FilePanel
					controller={panel}
					available={available}
					workspaceId="workspace"
					session={session}
					guard={(action) => action()}
					trigger={createRef()}
					id="files"
				/>
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	return html;
}
test("SSR closed surface has no empty dock; open dock has one named surface and bounded separator", () => {
	const panel = new FilePanelController(new LocalState());
	assert.equal(render(panel), "");
	panel.setOpen(true);
	assert.equal(render(panel, undefined, null), "");
	const html = render(panel);
	assert.equal((html.match(/class="file-workbench"/g) ?? []).length, 1);
	assert.match(html, /aria-valuemin="320"/);
	assert.match(html, /aria-valuenow="640"/);
	assert.match(html, /aria-orientation="vertical"/);
	assert.match(html, /收起文件/);
	assert.match(html, /<svg[^>]*width="16"[^>]*height="16"[^>]*class="lucide lucide-x"/);
	// Radix portals do not SSR their contents. Narrow mode must not leave a duplicate inline surface.
	assert.doesNotMatch(render(panel, undefined, 600), /file-workbench|file-panel-dock/);
});
test("hiding and reopening presentation leaves dirty editor ownership and protection unchanged", async () => {
	const client = {
		readText: async () => ({ text: "baseline", bytes: 8, revision: "a".repeat(64), encoding: "utf-8" }),
	} as FileClient;
	const session = new FileWorkspaceSession(client);
	port.files = client;
	await session.open({ workspaceId: "workspace", rootId: "root", path: "work.txt" }, true);
	editor(session).edit("unsaved work");
	const panel = new FilePanelController(new LocalState());
	panel.setOpen(true);
	assert.match(render(panel, session), /有未保存修改/);
	panel.setOpen(false);
	assert.equal(render(panel, session), "");
	assert.equal(session.protected, true);
	panel.setOpen(true);
	assert.match(render(panel, session), /work.txt/);
	assert.equal(editor(session).snapshot().document?.text, "unsaved work");
	session.dispose();
});
test("panel labels have matching English hierarchical keys in both languages", () => {
	assert.deepEqual(Object.keys(filePanelLabels("en")), Object.keys(filePanelLabels("zh")));
	for (const key of Object.keys(filePanelLabels("en"))) assert.match(key, /^filePanel\.[a-zA-Z]+$/);
});
