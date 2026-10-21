// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import postcss from "postcss";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ProjectHomeState } from "../../../src/features/workbench/composer/entry-state.ts";
import { PreparedTaskEntry } from "../../../src/features/workbench/composer/prepared-entry.tsx";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { ProjectFolderSummary } from "../../../src/features/workbench/projects/folder.tsx";
import { projectFolderLabels } from "../../../src/features/workbench/projects/folder-labels.ts";
import { WorkbenchWelcome } from "../../../src/features/workbench/workbench-welcome.tsx";

const preferences = vi.hoisted(() => ({ locale: "en", t: (key: string) => key }));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => preferences }));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useLocalState: () => local,
	useAppClient: () => client,
	useFiles: () => ({ fileAuthority }),
}));

const sharedCss = readFileSync(
	new NodeURL("../../../src/features/workbench/thread-column.css", import.meta.url),
	"utf8",
);
const homeCss = readFileSync(
	new NodeURL("../../../src/features/workbench/composer/home-layout.css", import.meta.url),
	"utf8",
);
let local: LocalState;
let folder: ProjectFolder;
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
let cache: QueryClient;
let style: HTMLStyleElement;
const client = { call: vi.fn() };
const fileAuthority = { getProject: vi.fn(async () => folder) };
const send = vi.fn(async () => {});
const manageFolder = vi.fn();
const manageModels = vi.fn();

function Home({
	projectState = "projectless",
	workspaceName = "A long project name that remains meaningful when the available column becomes narrow",
	folderFailed = false,
	focusRevision = 0,
}: {
	projectState?: ProjectHomeState;
	workspaceName?: string;
	folderFailed?: boolean;
	focusRevision?: number;
}) {
	const [draft, setDraft] = useState(() => local.read("task-draft.home") ?? "");
	return (
		<div className="work-conversation-frame">
			<WorkbenchWelcome
				projectState={projectState}
				workspaceName={projectState === "ready" ? workspaceName : undefined}
				context={
					projectState === "ready" && (
						<ProjectFolderSummary workspaceId="project" compact failed={folderFailed} onManage={manageFolder} />
					)
				}
				action={
					<PreparedTaskEntry
						workspaceId={projectState === "ready" ? "project" : ""}
						draft={draft}
						onDraftChange={(text) => {
							local.write("task-draft.home", text);
							setDraft(text);
						}}
						disabled={projectState === "pending" || projectState === "error"}
						busy={false}
						onSend={send}
						onManageModels={manageModels}
						focusRevision={focusRevision}
					/>
				}
			/>
		</div>
	);
}
async function render(props: Parameters<typeof Home>[0] = {}) {
	await act(async () =>
		renderer.render(
			<QueryClientProvider client={cache}>
				<Home {...props} />
			</QueryClientProvider>,
		),
	);
}
function query<T extends Element = HTMLElement>(selector: string) {
	const element = host.querySelector<T>(selector);
	assert.ok(element, selector);
	return element;
}
function declarations(css: string, selector: string) {
	const values = new Map<string, string>();
	postcss.parse(css).walkRules(selector, (rule) => {
		rule.walkDecls((declaration) => {
			values.set(declaration.prop, declaration.value);
		});
	});
	return values;
}
beforeEach(() => {
	preferences.locale = "en";
	local = new LocalState();
	folder = {
		workspaceId: "project",
		bindingId: "binding",
		revision: 1,
		status: "available",
		displayName: "Local source folder",
		root: { workspaceId: "project", rootId: "root", displayName: "Local source folder", writable: false },
	};
	send.mockReset();
	send.mockResolvedValue(undefined);
	manageFolder.mockClear();
	manageModels.mockClear();
	client.call.mockClear();
	fileAuthority.getProject.mockClear();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
	Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
	host = document.createElement("div");
	document.body.append(host);
	renderer = createRoot(host);
	cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity, refetchOnMount: false } },
	});
	cache.setQueryData(["models"], {
		models: [{ provider: "faux", modelId: "one", name: "Deterministic model" }],
		providers: [{ provider: "faux", name: "Faux", credentialState: "configured" }],
	});
	cache.setQueryData(["projectFolder", "project"], folder);
	style = document.createElement("style");
	// jsdom verifies matched declarations/DOM ownership, not browser layout or native pixels.
	style.textContent = sharedCss + homeCss.replace('@import "../thread-column.css";', "");
	document.head.append(style);
});
afterEach(async () => {
	await act(async () => renderer.unmount());
	cache.clear();
	host.remove();
	style.remove();
	document.getSelection()?.removeAllRanges();
	Reflect.deleteProperty(Range.prototype, "getClientRects");
	Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each(["projectless", "ready", "pending", "error"] as const)(
	"%s home mounts real input in one shared column, independently of hero and locale",
	async (projectState) => {
		for (const locale of ["en", "zh-CN"]) {
			preferences.locale = locale;
			await render({ projectState });
			const column = query(".welcome-action.conversation-column");
			const hero = query(".welcome-hero");
			const form = query(".welcome-composer .prepared-task-entry form");
			assert.equal(column.parentElement, hero.parentElement);
			assert.equal(host.querySelectorAll(".conversation-column").length, 1);
			assert.equal(hero.classList.contains("conversation-column"), false);
			assert.equal(form.parentElement?.closest(".conversation-column"), column);
			assert.equal(getComputedStyle(column).boxSizing, "border-box");
			assert.equal(getComputedStyle(hero).boxSizing, "border-box");
			assert.equal(query(".welcome").getAttribute("data-project-state"), projectState);
			assert.equal(host.querySelector(".welcome-context") !== null, projectState === "ready");
			assert.equal(
				host.querySelector(".welcome-heading-placeholder") !== null,
				["pending", "error"].includes(projectState),
			);
			assert.equal(query<HTMLButtonElement>(".composer-submit").disabled, true, "Empty input never submits");
			assert.equal(query('[role="textbox"]').getAttribute("aria-label"), "work.draft");
			assert.equal(form.contains(host.querySelector(".project-folder-summary")), false);
			assert.equal(client.call.mock.calls.length, 0);
			assert.equal(send.mock.calls.length, 0);
		}
	},
);

test("folder binding recovery stays visible and outside Send while using the same home column", async () => {
	for (const locale of ["en", "zh-CN"]) {
		preferences.locale = locale;
		for (const status of ["unavailable", "moved", "revoked"] as const) {
			folder = { ...folder, status };
			await act(async () => cache.setQueryData(["projectFolder", "project"], folder));
			await render({ projectState: "ready" });
			const summary = query<HTMLButtonElement>(".welcome-context .project-folder-summary");
			assert.equal(summary.getAttribute("data-healthy"), "false");
			assert.equal(
				summary.querySelector(".project-folder-secondary")?.textContent,
				projectFolderLabels(locale)[status],
			);
			assert.equal(summary.closest(".conversation-column"), query(".welcome-action"));
			assert.equal(summary.closest("form"), null);
			await act(async () => {
				summary.focus();
				summary.click();
			});
			assert.equal(manageFolder.mock.lastCall?.[0], summary);
			assert.equal(document.activeElement, summary);
			assert.equal(send.mock.calls.length, 0);
		}
		await render({ projectState: "ready", folderFailed: true });
		assert.equal(query(".project-folder-secondary").textContent, projectFolderLabels(locale).createFolderFailed);
	}
});

test("home state, font, panel and inherited width changes retain the real editor, draft, selection and focus", async () => {
	await render({ focusRevision: 1 });
	const editor = query('[role="textbox"]');
	assert.equal(document.activeElement, editor);
	const paste = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { getData: () => "保留草稿 and selection", files: [] } });
	await act(async () => editor.dispatchEvent(paste));
	const text = editor.querySelector("p")?.firstChild;
	assert.ok(text);
	const range = document.createRange();
	range.setStart(text, 1);
	range.setEnd(text, 4);
	const selection = document.getSelection();
	assert.ok(selection);
	await act(async () => {
		selection.removeAllRanges();
		selection.addRange(range);
		// A synthetic DOM Range must reach ProseMirror's selection owner before rerender/focus reconciliation.
		document.dispatchEvent(new Event("selectionchange"));
	});
	const selectedText = "留草稿";
	assert.equal(selection.toString(), selectedText);
	for (const projectState of ["ready", "pending", "error", "projectless"] as const) {
		preferences.locale = projectState === "ready" ? "zh-CN" : "en";
		host.style.setProperty("--reading-width", "52rem");
		host.style.setProperty("--thread-content-responsive-max-width", "36rem");
		host.style.setProperty("--thread-body-inline-padding", "18px");
		host.style.setProperty("--font-ui-size", "20px");
		host.style.fontSize = "20px";
		host.style.width = "420px";
		await render({ projectState, focusRevision: 1 });
		assert.equal(query('[role="textbox"]'), editor);
		assert.equal(editor.textContent, "保留草稿 and selection");
		assert.equal(local.read("task-draft.home"), "保留草稿 and selection");
		assert.equal(document.activeElement, editor);
		assert.equal(selection.toString(), selectedText);
		assert.equal(query<HTMLButtonElement>(".composer-submit").disabled, ["pending", "error"].includes(projectState));
		assert.equal(query(".welcome-action").closest(".work-conversation-frame"), query(".work-conversation-frame"));
		assert.equal(send.mock.calls.length, 0);
	}
	await act(async () => editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
	await act(async () =>
		editor.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229, bubbles: true }),
		),
	);
	assert.equal(send.mock.calls.length, 0, "IME confirmation remains non-submitting");
	await act(async () => editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
	await act(async () => query("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	assert.deepEqual(send.mock.calls, [["保留草稿 and selection", { provider: "faux", modelId: "one" }]]);
	assert.equal(local.read("task-draft.home"), "保留草稿 and selection", "Only the durable Send owner clears input");
});

test("shared column owns the exact inheritance and border-box formula; home owns only its separate hero and vertical split", () => {
	const activeCss = readFileSync(
		new NodeURL("../../../src/features/workbench/conversation/layout.css", import.meta.url),
		"utf8",
	);
	for (const css of [homeCss, activeCss]) assert.match(css, /^@import "\.\.\/thread-column\.css";/);
	const scope = declarations(sharedCss, ".conversation-panel,\n.work-conversation-frame > .welcome");
	assert.equal(scope.get("--thread-content-max-width"), "var(--reading-width)");
	assert.equal(scope.get("--conversation-inline-padding"), "calc(var(--spacing) * 4)");
	const column = declarations(sharedCss, ".conversation-column");
	assert.deepEqual(Object.fromEntries(column), {
		"--thread-content-max-width": "var(--thread-content-responsive-max-width, inherit)",
		"--thread-body-max-width": "calc(var(--thread-content-max-width) + var(--thread-body-inline-padding, 0px) * 2)",
		"box-sizing": "border-box",
		width: "100%",
		"min-width": "0",
		"max-width": "var(--thread-body-max-width)",
		"margin-inline": "auto",
		"padding-inline": "var(--thread-body-inline-padding, var(--conversation-inline-padding))",
	});
	const outer = declarations(homeCss, ".work-conversation-frame > .welcome");
	assert.equal(outer.get("padding"), "24px 0 0");
	assert.equal(outer.get("--home-hero-inline-padding"), "calc(var(--spacing) * 3)");
	assert.equal(outer.get("--home-hero-composer-gap"), "96px");
	assert.equal(outer.get("--home-composer-top-padding"), "6px");
	assert.equal(outer.get("--home-composer-bottom-padding"), "16px");
	const hero = declarations(homeCss, ".welcome .welcome-hero");
	assert.equal(hero.get("max-width"), "var(--thread-content-max-width)");
	assert.equal(hero.get("padding-inline"), "var(--home-hero-inline-padding)");
	assert.equal(hero.get("flex"), "1 0 0");
	const action = declarations(homeCss, ".welcome .welcome-action");
	assert.equal(action.get("flex"), "1 0 0");
	assert.equal(action.has("max-width"), false, "The home wrapper cannot override the shared formula");
	assert.equal(action.has("padding-inline"), false);
	assert.doesNotMatch(sharedCss + homeCss, /@(?:media|container)|--home-content-width|--home-inline-padding/);
	const theme = readFileSync(new NodeURL("../../../src/theme.css", import.meta.url), "utf8");
	assert.equal(declarations(theme, '.welcome[data-project-ready="true"] .welcome-action').size, 0);
});
