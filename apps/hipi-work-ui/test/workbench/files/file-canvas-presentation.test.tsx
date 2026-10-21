// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type FileRoot, FileServiceError, type FileText } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import type { FileAuthority } from "../../../src/app/file-client.ts";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { fileLabels } from "../../../src/features/files/file-labels.ts";
import { FileWorkbench } from "../../../src/features/files/file-workbench.tsx";
import { FileWorkspaceSession } from "../../../src/features/files/file-workspace-session.ts";
import { FilePanel } from "../../../src/features/workbench/files/panel.tsx";
import { FilePanelController } from "../../../src/features/workbench/files/panel-controller.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

function editor(session: FileWorkspaceSession) {
	const tab = session.snapshot().tabs.find((item) => item.id === session.snapshot().activeId);
	assert.ok(tab && tab.kind === "editor");
	return tab.editor;
}

const port = vi.hoisted(() => ({
	owner: {},
	files: undefined as FileClient | undefined,
	fileAuthority: undefined as FileAuthority | undefined,
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useFiles: () => port, useAppClient: () => port.owner }));

const baseline: FileText = { text: "original", revision: "a".repeat(64), encoding: "utf-8", bytes: 8 };
const root: FileRoot = { workspaceId: "workspace", rootId: "root", displayName: "Project", writable: true };
const target = { workspaceId: "workspace", rootId: "root", path: "notes.txt" };
const l = fileLabels("zh-CN");

function client(overrides: Partial<FileClient> = {}): FileClient {
	return {
		listRoots: async () => [root],
		list: async () => ({ entries: [], nextCursor: null }),
		readText: async () => baseline,
		saveText: async () => baseline,
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
		...overrides,
	};
}

beforeEach(() => {
	port.owner = {};
	port.files = client();
	port.fileAuthority = undefined;
});

function render({
	session,
	roots = [root],
	workspaceId = "workspace",
	panel = false,
}: {
	session?: FileWorkspaceSession;
	roots?: FileRoot[];
	workspaceId?: string;
	panel?: boolean;
} = {}) {
	const cache = new QueryClient();
	cache.setQueryData(["fileRoots", workspaceId], roots);
	const preferences = new LocalState();
	preferences.write("file-panel.open", "true");
	const controller = new FilePanelController(preferences);
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={cache}>
				<PreferencesProvider>
					{panel ? (
						<FilePanel
							controller={controller}
							available={1200}
							workspaceId={workspaceId}
							session={session}
							guard={(action) => action()}
							trigger={createRef()}
							id="file-canvas"
						/>
					) : (
						<FileWorkbench workspaceId={workspaceId} session={session} guard={(action) => action()} />
					)}
				</PreferencesProvider>
			</QueryClientProvider>,
		);
	} finally {
		cache.clear();
	}
}

function button(html: string, label: string) {
	const result = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((value) => value.endsWith(`${label}</button>`));
	assert.ok(result, `Missing button: ${label}`);
	return result;
}

test("file canvas has one visible panel title and a named close action while retaining the splitter", () => {
	const html = render({ panel: true });
	assert.equal((html.match(/<h2\b/g) ?? []).length, 1);
	assert.match(html, /class="file-panel-header"/);
	assert.match(html, /<h2 id="file-canvas-title">工作区文件<\/h2>/);
	assert.match(html, /aria-label="收起文件"/);
	assert.match(html, /<aside class="file-workbench" aria-label="项目文件"/);
	assert.match(html, /aria-controls="file-canvas-content"/);
	assert.match(html, /aria-valuemin="320"/);
});

test("folder authorization is separate from continuous browsing without refresh or pagination chrome", () => {
	const chooseRoot = vi.fn(async () => {});
	const revokeRoot = vi.fn(async () => {});
	port.fileAuthority = { chooseRoot, revokeRoot };
	const html = render();
	assert.ok(html.includes(l["access.title"]));
	assert.ok(html.includes("Project"));
	assert.ok(!html.includes(l.revoke), "Authorization controls are disclosed on demand, not mixed into file rows");
	assert.match(html, /class="file-tree-pane"/);
	assert.match(html, /data-file-tree-engine="pierre"/);
	assert.match(html, /aria-label="筛选已加载文件"/);
	assert.doesNotMatch(html, /aria-label="刷新目录"|下一页|刷新本页|加载更多/);
	assert.equal(chooseRoot.mock.calls.length, 0);
	assert.equal(revokeRoot.mock.calls.length, 0);
});

test("access disclosure keeps exact root permissions and only explicit actions choose or revoke authorization", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	const readonly: FileRoot = { ...root, rootId: "readonly", displayName: "Reference", writable: false };
	const chooseRoot = vi.fn(async () => {});
	const revokeRoot = vi.fn(async () => {});
	const readText = vi.fn(async () => baseline);
	const saveText = vi.fn(async () => baseline);
	port.files = client({ listRoots: async () => [root, readonly], readText, saveText });
	port.fileAuthority = { chooseRoot, revokeRoot };
	const session = new FileWorkspaceSession(port.files);
	// This test owns the access dialog; continuous tree navigation has independent mounted coverage.
	session.layout.treeOpen = false;
	const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
	cache.setQueryData(["fileRoots", "workspace"], [root, readonly]);
	const host = document.createElement("div");
	document.body.append(host);
	const renderer = createRoot(host);
	try {
		await act(async () =>
			renderer.render(
				<QueryClientProvider client={cache}>
					<PreferencesProvider>
						<FileWorkbench workspaceId="workspace" session={session} />
					</PreferencesProvider>
				</QueryClientProvider>,
			),
		);
		assert.equal(document.querySelector('[role="dialog"]'), null);
		const access = host.querySelector<HTMLButtonElement>(`button[aria-label="${l["access.title"]}"]`);
		assert.ok(access);
		await act(async () => access.click());
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		assert.ok(dialog);
		const rows = [...dialog.querySelectorAll<HTMLElement>(".file-access-row")];
		assert.equal(rows.length, 2);
		assert.equal(rows[0]?.querySelector(".file-access-name")?.textContent, "Project");
		assert.equal(rows[0]?.querySelector(".file-access-kind")?.textContent, l["access.readWrite"]);
		assert.equal(rows[1]?.querySelector(".file-access-name")?.textContent, "Reference");
		assert.equal(rows[1]?.querySelector(".file-access-kind")?.textContent, l.readonly);
		assert.equal(chooseRoot.mock.calls.length, 0);
		assert.equal(revokeRoot.mock.calls.length, 0);
		const choose = [...dialog.querySelectorAll("button")].find((button) => button.textContent === l.choose);
		assert.ok(choose);
		await act(async () => choose.click());
		assert.deepEqual(chooseRoot.mock.calls, [["workspace"]]);
		const revoke = rows[1]?.querySelector("button");
		assert.ok(revoke);
		await act(async () => revoke.click());
		assert.deepEqual(revokeRoot.mock.calls, [["workspace", "readonly"]]);
		assert.equal(readText.mock.calls.length, 0);
		assert.equal(saveText.mock.calls.length, 0);
	} finally {
		await act(async () => renderer.unmount());
		host.remove();
		cache.clear();
		session.dispose();
		vi.unstubAllGlobals();
	}
});

test("missing capability and workspace are intentional states without a simulated file picker", () => {
	port.files = undefined;
	const unavailable = render();
	assert.ok(unavailable.includes(l.unavailable));
	assert.match(unavailable, /file-state-empty/);
	assert.doesNotMatch(unavailable, /class="file-access"|class="file-tree"/);
	port.files = client();
	const noWorkspace = render({ workspaceId: "" });
	assert.ok(noWorkspace.includes(l.noWorkspace));
	assert.doesNotMatch(noWorkspace, /class="file-access"|class="file-tree"/);
});

test("no roots exposes access management and preserves desktop and HTTP setup guidance", () => {
	port.fileAuthority = { chooseRoot: async () => {}, revokeRoot: async () => {} };
	const session = new FileWorkspaceSession(client());
	try {
		const html = render({ session, roots: [] });
		assert.match(html, /class="file-access-body"/);
		assert.ok(html.includes(l.noRoots));
		assert.ok(html.includes(l.choose));
		assert.equal((html.match(/file-state-empty/g) ?? []).length, 1);
		assert.doesNotMatch(html, /class="file-buffer"/);
	} finally {
		session.dispose();
	}
});

test("a connected empty editor explains actual text and preview scope", () => {
	const session = new FileWorkspaceSession(client());
	try {
		const html = render({ session });
		assert.ok(html.includes(l["empty.selection"]));
		assert.ok(html.includes(l.open));
		assert.match(html, /128 KiB/);
	} finally {
		session.dispose();
	}
});

test("dirty document keeps its memory disclosure and groups edits, reconciliation, and actual views", async () => {
	const session = new FileWorkspaceSession(client());
	try {
		await session.open(target, true);
		editor(session).edit("unsaved input");
		const html = render({ session });
		assert.match(html, /class="file-editor-toolbar"/);
		assert.match(html, /role="tab"/);
		assert.match(html, /data-dirty="true"/);
		assert.ok(html.includes(l.dirty));
		assert.ok(html.includes(l.memory));
		assert.match(html, /aria-label="文件操作"/);
		assert.match(button(html, l.edit), /aria-pressed="true"/);
		assert.match(button(html, l.diff), /aria-pressed="false"/);
		assert.ok(html.includes(l["autosave.pending"]));
		assert.equal(editor(session).snapshot().document?.diffBaseline.text, "original");
	} finally {
		session.dispose();
	}
});

test("read-only document keeps an explicit permission badge and cannot save", async () => {
	const session = new FileWorkspaceSession(client());
	try {
		await session.open(target, false);
		const html = render({ session });
		assert.ok(html.includes(l.readonly));
		assert.match(html, /aria-label="文件操作"/);
	} finally {
		session.dispose();
	}
});

for (const outcome of ["VERSION_CONFLICT", "WRITE_OUTCOME_UNKNOWN"] as const) {
	test(`${outcome} keeps input, warns explicitly, and disables another save without hiding reconciliation`, async () => {
		const session = new FileWorkspaceSession(
			client({
				saveText: async () => {
					throw new FileServiceError(outcome);
				},
			}),
		);
		try {
			await session.open(target, true);
			editor(session).edit("preserve this input");
			await editor(session).save();
			const html = render({ session });
			assert.match(html, /role="alert" class="file-state file-state-alert" data-tone="warning"/);
			assert.ok(html.includes(outcome === "VERSION_CONFLICT" ? l.conflict : l.unknown));
			assert.match(html, /aria-label="文件操作"/);
			assert.doesNotMatch(button(html, l.compare), /disabled=/);
			assert.equal(editor(session).snapshot().document?.text, "preserve this input");
			assert.equal(editor(session).snapshot().document?.diffBaseline.text, "original");
			assert.equal(session.protected, true);
		} finally {
			session.dispose();
		}
	});
}

test("loading uses the real operation label and retains stop-waiting semantics", async () => {
	let finish: (value: FileText) => void = () => {};
	const reading = new Promise<FileText>((resolve) => {
		finish = resolve;
	});
	const session = new FileWorkspaceSession(client({ readText: () => reading }));
	const opening = session.open(target, true);
	try {
		const html = render({ session });
		assert.ok(html.includes(l["operation.read"]));
		assert.ok(html.includes(l.cancel));
		assert.ok(!html.includes(l["empty.selection"]));
	} finally {
		finish(baseline);
		await opening;
		session.dispose();
	}
});

test("new presentation labels are localized with the same stable keys", () => {
	assert.deepEqual(Object.keys(fileLabels("en")), Object.keys(fileLabels("zh-CN")));
	for (const key of Object.keys(fileLabels("en")).filter(
		(key) => key.startsWith("toolbar.") || key.startsWith("state."),
	)) {
		assert.match(key, /^[a-z]+\.[a-zA-Z]+$/);
	}
});
