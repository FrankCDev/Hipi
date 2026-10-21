// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Conversation, SidebarPage, SidebarWindowResult } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { defaultConfig } from "../../../src/app/theme/config.ts";
import { useThemeSettings } from "../../../src/app/theme/provider.tsx";
import { themeStorageKey } from "../../../src/app/theme/store.ts";
import { useReducedMotionPreference } from "../../../src/app/theme/use-reduced-motion.ts";
import { ActionTooltipProvider } from "../../../src/components/ui/action-tooltip.tsx";
import { CatalogPagination } from "../../../src/features/workbench/catalog/pagination.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { navigationKey } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";
import {
	SidebarOrderSection,
	SidebarSectionContent,
	SidebarSectionHeading,
} from "../../../src/features/workbench/sidebar/section.tsx";
import { SidebarSelectionProvider } from "../../../src/features/workbench/sidebar/selection-provider.tsx";
import { WorkspaceTree } from "../../../src/features/workbench/sidebar/workspace-tree.tsx";

// Real React, Query, Motion and Radix owners. jsdom establishes lifecycle/focus,
// not native inert enforcement, pointer modality or painted geometry.
const conversation: Conversation = {
	workspaceId: "workspace",
	conversationId: "chat",
	title: "Existing chat",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const page: SidebarPage = {
	items: [{ conversation, recencyAt: 1, activityBasis: "creation" }],
	nextCursor: null,
	coverage: { generation: "one", membershipGeneration: 0, state: "ready", completedAt: 1, nextCursor: null },
};
const key = navigationKey({ kind: "workspace", workspaceId: "workspace" }, "active");
let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
let client: AppClient;
let catalog: CatalogSession;
function Fixture({ expanded, sectionCollapsed = false }: { expanded: boolean; sectionCollapsed?: boolean }) {
	const sidebar = useRef<HTMLElement>(null);
	return (
		<>
			<textarea aria-label="Dirty editor" defaultValue="Unsaved working draft" />
			<aside ref={sidebar}>
				<SidebarSelectionProvider
					scope={{ workspaceId: "workspace", conversationId: "chat" }}
					preferredLocation={null}
					rootRef={sidebar}
				>
					<SidebarPreviewProvider disabled={false} navigationKey="stable">
						<SidebarOrderSection
							collapsed={sectionCollapsed}
							action={{
								item: {
									id: "projects",
									group: "sections",
									label: "Projects",
									revision: "1",
									after: null,
									move: async () => {},
								},
								up: null,
								down: null,
							}}
						>
							<SidebarSectionHeading>Projects</SidebarSectionHeading>
							<SidebarSectionContent>
								<WorkspaceTree
									catalog={catalog}
									guard={(action) => action()}
									workspaces={[{ workspaceId: "workspace", name: "Project" }]}
									section="projects"
									selectedWorkspace="workspace"
									selectedConversation="chat"
									isExpanded={() => expanded}
									onToggle={() => {}}
									onOpenProject={() => {}}
									onSelect={() => {}}
									onNewConversation={() => {}}
								/>
							</SidebarSectionContent>
						</SidebarOrderSection>
					</SidebarPreviewProvider>
				</SidebarSelectionProvider>
			</aside>
		</>
	);
}
async function render(expanded: boolean, sectionCollapsed = false) {
	await act(async () =>
		root.render(
			<AppClientProvider client={client}>
				<QueryClientProvider client={cache}>
					<PreferencesProvider>
						<ActionTooltipProvider>
							<Fixture expanded={expanded} sectionCollapsed={sectionCollapsed} />
						</ActionTooltipProvider>
					</PreferencesProvider>
				</QueryClientProvider>
			</AppClientProvider>,
		),
	);
}
async function settle(ms = 450) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
	const found = document.querySelector<T>(selector);
	assert.ok(found, selector);
	return found;
}
async function openMenu() {
	await act(async () =>
		node(".conversation-actions-trigger").dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }),
		),
	);
	await settle(0);
	assert.ok(document.querySelector("[role='menu']"));
}
function viewport(region: HTMLElement) {
	const rect = (top: number, height = 0) => new DOMRect(0, top, 100, height);
	vi.spyOn(region, "getBoundingClientRect").mockImplementation(() => rect(0, 100));
	vi.spyOn(region, "getClientRects").mockReturnValue({
		0: rect(0, 100),
		length: 1,
		item: (index: number) => (index === 0 ? rect(0, 100) : null),
		*[Symbol.iterator]() {
			yield rect(0, 100);
		},
	});
	const edge = region.querySelector<HTMLElement>("[data-catalog-boundary]");
	assert.ok(edge);
	let top = 150;
	vi.spyOn(edge, "getBoundingClientRect").mockImplementation(() => rect(top));
	return async (nextTop = 80) => {
		top = nextTop;
		region.dispatchEvent(new Event("scroll"));
		await settle(40);
	};
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// jsdom has no viewport scrolling; Radix focus restoration remains real.
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	localStorage.setItem(themeStorageKey, JSON.stringify({ ...defaultConfig(), reducedMotion: "off" }));
	cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	cache.setQueryData(key, { pages: [page], cursors: [undefined] });
	client = { call: vi.fn(async () => page) as AppClient["call"], observe: vi.fn() };
	catalog = new CatalogSession(client, new LocalState());
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await render(true);
});
afterEach(async () => {
	await act(async () => root.unmount());
	cache.clear();
	catalog.dispose();
	host.remove();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("collapse fences immediately, temporarily retains rows, and retires them without losing its query owner", async () => {
	const region = node(".project-conversations");
	const row = node(".conversation-link");
	const query = cache.getQueryCache().find({ queryKey: key });
	assert.ok(query?.isActive());
	await render(false);
	assert.equal(region.hasAttribute("inert"), true);
	assert.equal(region.getAttribute("aria-hidden"), "true");
	assert.equal(node(".project-toggle").getAttribute("aria-expanded"), "false");
	assert.equal(node(".project-toggle").closest("[inert]"), null);
	assert.equal(node(".conversation-link"), row);
	assert.equal(query.isActive(), false);
	assert.equal(query.getObserversCount(), 1);
	await settle();
	assert.equal(document.querySelector(".conversation-link"), null);
	assert.equal(region.hidden, true);
	assert.equal(node(".project-conversations"), region);
	await render(true);
	assert.ok(node(".conversation-link"));
	assert.equal(query.isActive(), true);
});
test("rapid reopen preserves rows and later collapse leaves dirty editor focus and value intact", async () => {
	const row = node(".conversation-link");
	await render(false);
	await render(true);
	assert.equal(node(".conversation-link"), row);
	const editor = node<HTMLTextAreaElement>("textarea");
	await act(async () => editor.focus());
	await render(false);
	await settle();
	assert.equal(document.activeElement, editor);
	assert.equal(editor.value, "Unsaved working draft");
	assert.equal(document.querySelector(".conversation-link"), null);
});
test("owned keyboard focus returns to the disclosure while the open preview closes", async () => {
	const row = node(".conversation-link");
	const matches = row.matches.bind(row);
	// Supply keyboard modality only; preserve actual focus, React and Radix behavior.
	vi.spyOn(row, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
	await act(async () => row.focus());
	await settle(0);
	assert.ok(document.querySelector(".conversation-preview-card"));
	await render(false);
	assert.equal(document.querySelector(".conversation-preview-card"), null);
	assert.equal(document.activeElement, node(".project-toggle"));
});
test("branch availability closes an open menu and cancels a pending icon tooltip", async () => {
	await openMenu();
	await render(false);
	assert.equal(document.querySelector("[role='menu']"), null);
	await render(true);
	await act(async () =>
		node(".conversation-actions-trigger").dispatchEvent(
			new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
		),
	);
	await render(false);
	await settle();
	assert.equal(document.querySelector("[role='tooltip']"), null);
});
test("real rename retains its draft and modal focus during exit, then releases the retained rows", async () => {
	await openMenu();
	const rename = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
		(item) => item.textContent === "重命名会话",
	);
	assert.ok(rename);
	await act(async () => rename.click());
	await settle(0);
	const input = node<HTMLInputElement>(".conversation-rename-input");
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	assert.ok(setter);
	await act(async () => {
		setter.call(input, "Uncommitted rename draft");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
	});
	await render(false);
	await settle();
	assert.equal(node(".conversation-rename-input"), input);
	assert.equal(input.value, "Uncommitted rename draft");
	assert.equal(document.activeElement, input);
	assert.equal(node(".project-conversations").hidden, true);
	await act(async () => node<HTMLButtonElement>(".conversation-rename-cancel").click());
	await settle();
	assert.equal(document.querySelector(".conversation-rename-input"), null);
	assert.equal(document.querySelector(".conversation-link"), null);
	assert.equal(document.activeElement, node(".project-toggle"));
});

test("a delayed viewport read is cancelled on project retirement and cannot reclaim dirty editor focus", async () => {
	await act(async () => cache.setQueryData(key, { pages: [{ ...page, nextCursor: "last" }], cursors: [undefined] }));
	await settle(0);
	let finish: ((value: SidebarWindowResult) => void) | undefined;
	let signal: AbortSignal | undefined;
	vi.mocked(client.call).mockImplementation(((_method, _params, readSignal) => {
		signal = readSignal;
		return new Promise<SidebarWindowResult>((resolve) => {
			finish = resolve;
		});
	}) as AppClient["call"]);
	const demand = viewport(node(".project-conversations"));
	await demand(150);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0, "Offscreen continuation is not fetched");
	await demand();
	assert.ok(finish);
	assert.deepEqual(vi.mocked(client.call).mock.calls[0]?.slice(0, 2), [
		"listSidebarWindow",
		{
			view: { kind: "workspace", workspaceId: "workspace" },
			filter: "active",
			position: { kind: "continue", cursor: "last" },
			retainedScopes: [{ workspaceId: "workspace", conversationId: "chat" }],
		},
	]);
	assert.ok(signal);
	assert.equal(signal.aborted, false);
	const retained = cache.getQueryData(key);
	await render(false);
	const editor = node<HTMLTextAreaElement>("textarea");
	await act(async () => editor.focus());
	await settle();
	assert.equal(signal.aborted, true);
	await act(async () =>
		finish?.({ ...page, kind: "window", previousCursor: "earlier", retained: { eligible: [], unavailable: [] } }),
	);
	await settle(0);
	assert.deepEqual(cache.getQueryData(key), retained, "A cancelled late reply cannot replace the coherent window");
	assert.equal(document.activeElement, editor);
	assert.equal(editor.value, "Unsaved working draft");
	assert.equal(document.querySelector(".project-pagination button"), null);
	assert.equal(node(".project-conversations").hidden, true);
});

for (const fence of ["inert", "hidden", "visible"] as const) {
	test(`last viewport callback never claims body focus in a ${fence} region`, async () => {
		let finish: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const requested = vi.fn();
		function PaginationFixture({ closed }: { closed: boolean }) {
			const list = useRef<HTMLElement>(null);
			const [loading, setLoading] = useState(false);
			const [hasMore, setHasMore] = useState(true);
			return (
				<section
					ref={list}
					tabIndex={-1}
					data-pagination-region=""
					inert={closed && fence === "inert"}
					hidden={closed && fence === "hidden"}
				>
					<button type="button" data-catalog-key="row">
						Existing row
					</button>
					<CatalogPagination
						listRef={list}
						pages={{
							hasMore,
							hasPrevious: false,
							isFetching: loading,
							isError: false,
							itemKeys: ["row"],
							evictedKeys: () => [],
							async loadMore() {
								requested();
								setLoading(true);
								await pending;
								setHasMore(false);
								setLoading(false);
							},
							async loadPrevious() {},
						}}
					/>
				</section>
			);
		}
		const paint = async (closed: boolean) => {
			await act(async () =>
				root.render(
					<PreferencesProvider>
						<PaginationFixture closed={closed} />
					</PreferencesProvider>,
				),
			);
		};
		await paint(false);
		const region = node("[data-pagination-region]");
		const demand = viewport(region);
		const row = node<HTMLButtonElement>("[data-catalog-key='row']");
		await act(async () => row.focus());
		await demand();
		assert.equal(requested.mock.calls.length, 1);
		assert.equal(document.activeElement, row, "Loading never moves focus from the real row");
		await paint(true);
		await act(async () => row.blur());
		assert.equal(document.activeElement, document.body);
		await act(async () => finish?.());
		await demand();
		assert.equal(requested.mock.calls.length, 1, "A settled terminal read cannot loop");
		assert.equal(region.hasAttribute("inert"), fence === "inert");
		assert.equal(region.hidden, fence === "hidden");
		assert.deepEqual([...region.querySelectorAll("button")], [row], "Only the content row remains focusable");
		assert.equal(document.querySelector(".project-pagination button"), null);
		assert.equal(document.activeElement, document.body);
	});
}

test("failed viewport continuation retains rows and dirty input until explicit error retry succeeds", async () => {
	await act(async () => cache.setQueryData(key, { pages: [{ ...page, nextCursor: "last" }], cursors: [undefined] }));
	await settle(0);
	let failing = true;
	vi.mocked(client.call).mockImplementation((async () => {
		if (failing) throw new Error("Read unavailable");
		return {
			...page,
			kind: "window",
			items: [{ ...page.items[0], conversation: { ...conversation, conversationId: "last", title: "Last chat" } }],
			previousCursor: "earlier",
			retained: { eligible: [], unavailable: [] },
		};
	}) as AppClient["call"]);
	const row = node(".conversation-link");
	const editor = node<HTMLTextAreaElement>("textarea");
	await act(async () => editor.focus());
	const demand = viewport(node(".project-conversations"));
	await demand();
	assert.ok(node("[role='alert']"));
	assert.equal(node(".conversation-link"), row);
	assert.equal(document.activeElement, editor);
	assert.equal(editor.value, "Unsaved working draft");
	await demand();
	assert.equal(vi.mocked(client.call).mock.calls.length, 1, "An error does not auto-retry from viewport demand");
	failing = false;
	await act(async () => node<HTMLButtonElement>("[role='alert'] button").click());
	await settle(40);
	assert.equal(vi.mocked(client.call).mock.calls.length, 2);
	assert.deepEqual(
		vi.mocked(client.call).mock.calls[1]?.slice(0, 2),
		vi.mocked(client.call).mock.calls[0]?.slice(0, 2),
	);
	assert.equal(document.querySelector("[role='alert']"), null);
	assert.equal(node(".conversation-link"), row);
	assert.match(host.textContent ?? "", /Last chat/);
	assert.equal(document.activeElement, editor);
	assert.equal(editor.value, "Unsaved working draft");
	assert.equal(document.querySelector(".project-pagination button"), null);
});

test("live reduced-motion preference follows system changes and explicit on/off overrides", async () => {
	let system = false;
	const media = new EventTarget();
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const query = {
		get matches() {
			return system;
		},
		media: "(prefers-reduced-motion: reduce)",
		onchange: null,
		addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			if (type === "change") listeners.add(listener);
			media.addEventListener(type, listener);
		},
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			listeners.delete(listener);
			media.removeEventListener(type, listener);
		},
		dispatchEvent(event: Event) {
			return media.dispatchEvent(event);
		},
		addListener() {},
		removeListener() {},
	};
	vi.stubGlobal("matchMedia", (value: string) => (value === query.media ? query : { ...query, matches: false }));
	function PreferenceProbe() {
		const { config, update } = useThemeSettings();
		const reduced = useReducedMotionPreference();
		return (
			<>
				<output data-reduced={String(reduced)} />
				{(["system", "on", "off"] as const).map((value) => (
					<button
						key={value}
						type="button"
						data-motion-setting={value}
						onClick={() => update({ ...config, reducedMotion: value })}
					>
						{value}
					</button>
				))}
			</>
		);
	}
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<PreferenceProbe />
			</PreferencesProvider>,
		),
	);
	const choose = async (value: string) => {
		await act(async () => node<HTMLButtonElement>(`[data-motion-setting="${value}"]`).click());
	};
	const reduced = () => node("output").dataset.reduced;
	await choose("system");
	assert.equal(reduced(), "false");
	await act(async () => {
		system = true;
		media.dispatchEvent(new Event("change"));
	});
	assert.equal(reduced(), "true");
	await choose("off");
	assert.equal(reduced(), "false");
	await act(async () => {
		system = false;
		media.dispatchEvent(new Event("change"));
	});
	assert.equal(reduced(), "false");
	await choose("on");
	assert.equal(reduced(), "true");
	await choose("system");
	assert.equal(reduced(), "false");
	await act(async () => root.render(null));
	assert.equal(listeners.size, 0);
});

test.each([false, true])("Projects exit retains the actual rename dialog, reopen before cancel=%s", async (reopen) => {
	await openMenu();
	const rename = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
		(item) => item.textContent === "重命名会话",
	);
	assert.ok(rename);
	await act(async () => rename.click());
	await settle(0);
	const input = node<HTMLInputElement>(".conversation-rename-input");
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	assert.ok(setter);
	await act(async () => {
		setter.call(input, "Draft through section collapse");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
	});
	await render(true, true);
	assert.equal(node(".sidebar-section-content").hasAttribute("inert"), true);
	await settle(40);
	await render(true, false);
	assert.equal(node(".conversation-rename-input"), input);
	assert.equal(input.value, "Draft through section collapse");
	assert.equal(document.activeElement, input);
	await render(true, true);
	await settle();
	assert.equal(node(".conversation-rename-input"), input);
	assert.equal(input.value, "Draft through section collapse");
	assert.equal(document.activeElement, input);
	if (reopen) {
		const row = node(".conversation-link");
		await render(true, false);
		assert.equal(node(".conversation-link"), row);
		assert.equal(node(".conversation-rename-input"), input);
		assert.equal(document.activeElement, input);
	}
	await act(async () => node<HTMLButtonElement>(".conversation-rename-cancel").click());
	await settle();
	assert.equal(document.querySelector(".conversation-rename-input"), null);
	if (reopen) {
		assert.ok(node(".conversation-link"));
		assert.equal(document.activeElement, node(".conversation-actions-trigger"));
	} else {
		assert.equal(document.querySelector(".conversation-link"), null);
		assert.equal(document.activeElement, node(".sidebar-section-toggle"));
	}
});

test("ordinary Projects collapse retires nested project rows without a presence deadlock", async () => {
	assert.ok(node(".conversation-link"));
	await render(true, true);
	assert.equal(node(".sidebar-section-content").hasAttribute("inert"), true);
	await settle();
	assert.equal(document.querySelector(".conversation-link"), null);
	assert.equal(document.querySelector(".project-row"), null);
	assert.equal(node(".sidebar-section-toggle").getAttribute("aria-expanded"), "false");
	await render(true, false);
	assert.ok(node(".conversation-link"));
});
