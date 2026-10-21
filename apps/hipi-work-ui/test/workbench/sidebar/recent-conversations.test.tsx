import assert from "node:assert/strict";
import type { AppClient, Scope, SidebarWindowRequest, SidebarWindowResult } from "@hipi/work-runtime/contracts";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryObserver, type UseQueryOptions } from "@tanstack/react-query";
import type * as Virtual from "@tanstack/react-virtual";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../../../src/components/ui/button.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { ConversationPreview } from "../../../src/features/workbench/sidebar/conversation-preview.tsx";
import { RecentConversations } from "../../../src/features/workbench/sidebar/recent-conversations.tsx";
import { WindowInteractionContext } from "../../../src/features/workbench/sidebar/window-interaction.tsx";
import {
	type RecentWindow,
	readRecentWindow,
	scopeKey,
	type WindowPage,
	windowKey,
} from "../../../src/features/workbench/sidebar/window-query.ts";

type Cell = { value?: unknown; deps?: React.DependencyList; cleanup?: () => void };
const fixture = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	dirty: false,
	layouts: [] as (() => void)[],
	effects: [] as (() => void)[],
	collapsed: false,
	dragging: false,
	cache: undefined as QueryClient | undefined,
	client: undefined as AppClient | undefined,
	options: undefined as UseQueryOptions<RecentWindow> | undefined,
	virtualizer: undefined as Virtual.Virtualizer<HTMLElement, HTMLLIElement> | undefined,
	scrollOffset: 0,
	query: {
		data: undefined as RecentWindow | undefined,
		dataUpdatedAt: 1,
		isFetching: false,
		isError: false,
		isPending: false,
		refetch: vi.fn(),
	},
}));
// Production hooks/callbacks and real window-query/cache operations with explicit
// DOM and query-observer seams. Keyed identity is a reconciliation model, not a
// mounted React, native focus, scrollbar or painted-frame acceptance proof.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const effect = (queue: (() => void)[], setup: React.EffectCallback, deps?: React.DependencyList) => {
		const index = fixture.cursor++;
		const previous = fixture.cells[index];
		if (
			deps &&
			previous?.deps &&
			deps.length === previous.deps.length &&
			deps.every((value, at) => Object.is(value, previous.deps?.[at]))
		)
			return;
		queue.push(() => {
			previous?.cleanup?.();
			const cleanup = setup();
			fixture.cells[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
		});
	};
	return {
		...actual,
		useId: () => "recent-heading",
		useRef: (value: unknown) => {
			const index = fixture.cursor++;
			fixture.cells[index] ??= { value: { current: value } };
			return fixture.cells[index].value;
		},
		useState: <T,>(initial: T | (() => T)) => {
			const index = fixture.cursor++;
			const cell = fixture.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			fixture.cells[index] = cell;
			return [
				cell.value,
				(update: React.SetStateAction<T>) => {
					const next = typeof update === "function" ? (update as (value: T) => T)(cell.value as T) : update;
					if (!Object.is(next, cell.value)) fixture.dirty = true;
					cell.value = next;
				},
			];
		},
		useCallback: (callback: unknown, deps: React.DependencyList) => {
			const index = fixture.cursor++;
			const previous = fixture.cells[index];
			if (!previous?.deps || deps.some((value, at) => !Object.is(value, previous.deps?.[at])))
				fixture.cells[index] = { value: callback, deps };
			return fixture.cells[index]?.value;
		},
		useMemo: (create: () => unknown, deps: React.DependencyList) => {
			const index = fixture.cursor++;
			const previous = fixture.cells[index];
			if (!previous?.deps || deps.some((value, at) => !Object.is(value, previous.deps?.[at])))
				fixture.cells[index] = { value: create(), deps };
			return fixture.cells[index]?.value;
		},
		useLayoutEffect: (setup: React.EffectCallback, deps?: React.DependencyList) => effect(fixture.layouts, setup, deps),
		useEffect: (setup: React.EffectCallback, deps?: React.DependencyList) => effect(fixture.effects, setup, deps),
	};
});
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<typeof Query>("@tanstack/react-query");
	return {
		...actual,
		useQueryClient: () => fixture.cache,
		useQuery: (options: UseQueryOptions<RecentWindow>) => {
			fixture.options = options;
			return fixture.query;
		},
	};
});
// Keep the installed Virtualizer algorithm and the production hook/range
// extractor. Only the React binding and native measurement/event inputs are
// controlled; no replacement virtual-range algorithm is invented by the test.
vi.mock("@tanstack/react-virtual", async () => {
	const actual = await vi.importActual<typeof Virtual>("@tanstack/react-virtual");
	return {
		...actual,
		useVirtualizer: (options: Parameters<typeof Virtual.useVirtualizer<HTMLElement, HTMLLIElement>>[0]) => {
			const configured = {
				...options,
				initialRect: { width: 300, height: 360 },
				observeElementRect: () => {},
				observeElementOffset: () => {},
				scrollToFn: () => {},
			};
			fixture.virtualizer ??= new actual.Virtualizer(configured);
			fixture.virtualizer.setOptions(configured);
			fixture.virtualizer.scrollOffset = fixture.scrollOffset;
			fixture.virtualizer.scrollRect = { width: 300, height: 360 };
			return fixture.virtualizer;
		},
	};
});
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => fixture.client }));
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/features/workbench/sidebar/drag-provider.tsx", () => ({
	useSidebarDragging: () => fixture.dragging,
}));
vi.mock("../../../src/features/workbench/sidebar/section.tsx", () => ({
	useSidebarSection: () => ({ collapsed: fixture.collapsed }),
	SidebarSectionHeading: () => null,
	SidebarSectionContent: () => null,
}));
const view = { kind: "project_recent" } as const;
const key = windowKey(view, "active");
const coverage = {
	generation: "one",
	membershipGeneration: 0,
	projectMembershipGeneration: 0,
	projectOrderGeneration: 0,
	state: "ready",
	completedAt: 1,
	nextCursor: null,
} as const;
function page(start = 0, length = 50, nextCursor: string | null = "next", workspaceId = "physical"): WindowPage {
	return {
		kind: "window",
		coverage,
		previousCursor: start ? "previous" : null,
		nextCursor,
		retained: { eligible: [], unavailable: [] },
		items: Array.from({ length }, (_, offset) => ({
			conversation: {
				workspaceId,
				conversationId: String(start + offset),
				title: `Conversation ${start + offset}`,
				revision: 1,
				createdAt: 1,
				archivedAt: null,
			},
			membership: { workspaceId, conversationId: String(start + offset), projectId: null, revision: 1 },
			recencyAt: 1,
			activityBasis: "creation",
		})),
	};
}
function snapshot(pages: WindowPage[], action: RecentWindow["action"] = "refresh"): RecentWindow {
	return {
		pages,
		retained: pages.at(-1)?.retained ?? { eligible: [], unavailable: [] },
		paused: false,
		unpublished: false,
		action,
		revision: 1,
	};
}
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function only<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	assert.ok(found[0]);
	return found[0];
}
function invoke(callback: unknown, ...args: unknown[]) {
	assert.equal(typeof callback, "function");
	return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, args);
}
class ElementStub extends EventTarget {
	isConnected = true;
	dataset: Record<string, string> = {};
	parent: ElementStub | null = null;
	children: ElementStub[] = [];
	hidden = false;
	scrollTop = 0;
	kind: "body" | "root" | "region" | "row" | "link" | "sentinel" | "outside" = "outside";
	focus = vi.fn(() => {
		documentStub.activeElement = this;
	});
	contains(target: unknown): boolean {
		return this === target || this.children.some((child) => child.contains(target));
	}
	closest(selector: string): ElementStub | null {
		if (selector === "[hidden],[inert]" || selector === "[data-sidebar-row-portal]") return this.hidden ? this : null;
		if (selector === "[data-window-row]" && this.kind === "row") return this;
		if ((selector === "[data-sidebar-navigation-root]" || selector === ".navigation-list") && this.kind === "root")
			return this;
		return this.parent?.closest(selector) ?? null;
	}
	querySelectorAll(selector: string): ElementStub[] {
		return this.children.flatMap((child) => [
			...((selector === "[data-window-row]" && child.kind === "row") ||
			(selector === ".conversation-link" && child.kind === "link")
				? [child]
				: []),
			...child.querySelectorAll(selector),
		]);
	}
	querySelector(selector: string) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	getBoundingClientRect() {
		return { top: this.kind === "row" ? 20 : 0, bottom: this.kind === "row" ? 56 : 400 };
	}
	getClientRects() {
		return this.hidden ? [] : [this.getBoundingClientRect()];
	}
}
let documentStub: EventTarget & { visibilityState: string; body: ElementStub; activeElement: ElementStub };
const observers: ObserverStub[] = [];
class ObserverStub {
	observed = new Set<ElementStub>();
	disconnected = false;
	callback: (entries: { target: ElementStub; isIntersecting: boolean }[]) => void;
	constructor(callback: ObserverStub["callback"]) {
		this.callback = callback;
		observers.push(this);
	}
	observe(target: ElementStub) {
		this.observed.add(target);
	}
	unobserve(target: ElementStub) {
		this.observed.delete(target);
	}
	disconnect() {
		this.disconnected = true;
		this.observed.clear();
	}
}
function node(kind: ElementStub["kind"]) {
	const value = new ElementStub();
	value.kind = kind;
	return value;
}
function harness(extra: Partial<React.ComponentProps<typeof RecentConversations>> = {}) {
	assert.ok(fixture.client && fixture.cache);
	const props: React.ComponentProps<typeof RecentConversations> = {
		catalog: new CatalogSession(fixture.client, new LocalState()),
		onSelect: vi.fn(),
		logicalReady: true,
		filter: "active",
		filterMenu: null,
		...extra,
	};
	const root = node("root");
	const region = node("region");
	region.parent = root;
	root.children = [region];
	const top = node("sentinel");
	const bottom = node("sentinel");
	const control = node("outside");
	const retryControl = node("outside");
	const rows = new Map<string, ElementStub>();
	let output: React.ReactNode;
	let afterCommit: { run: () => void; ready: () => boolean } | undefined;
	let beforeCommit: { run: () => void; ready: (next: React.ReactNode) => boolean } | undefined;
	const render = () => {
		for (let attempts = 0; attempts < 20; attempts++) {
			fixture.cursor = 0;
			fixture.dirty = false;
			output = RecentConversations(props);
			if (beforeCommit?.ready(output)) {
				const pending = beforeCommit;
				beforeCommit = undefined;
				pending.run();
			}
			const section = only(output, "section");
			assert.ok(section.props.ref && typeof section.props.ref === "object");
			Object.assign(section.props.ref, { current: region });
			const items = elements(only(output, "ul").props.children, "li");
			const present = new Set<string>();
			region.children = [];
			for (const item of items) {
				if (item.props.ref && typeof item.props.ref === "object")
					Object.assign(item.props.ref, { current: item.key === "previous" ? top : bottom });
				if (item.props.className !== "conversation-nav-item") continue;
				assert.ok(item.key);
				present.add(item.key);
				let row = rows.get(item.key);
				if (!row) {
					row = node("row");
					const link = node("link");
					link.parent = row;
					row.children = [link];
					row.dataset = {
						workspaceId: String(Reflect.get(item.props, "data-workspace-id")),
						conversationId: String(Reflect.get(item.props, "data-conversation-id")),
					};
					link.dataset = row.dataset;
					rows.set(item.key, row);
				}
				row.parent = region;
				region.children.push(row);
			}
			for (const [identity, row] of rows)
				if (!present.has(identity)) {
					row.isConnected = false;
					for (const link of row.children) {
						link.isConnected = false;
						if (documentStub.activeElement === link) documentStub.activeElement = documentStub.body;
					}
					rows.delete(identity);
				}
			for (const [label, element] of [
				["work.showMore", control],
				["nav.refresh", retryControl],
			] as const) {
				element.isConnected = elements(output, Button).some((button) => button.props.children === label);
				if (!element.isConnected && documentStub.activeElement === element)
					documentStub.activeElement = documentStub.body;
			}
			if (afterCommit?.ready()) {
				const pending = afterCommit;
				afterCommit = undefined;
				pending.run();
			}
			for (const effect of fixture.layouts.splice(0)) effect();
			for (const effect of fixture.effects.splice(0)) effect();
			if (!fixture.dirty) return output;
		}
		throw new Error("Hook harness failed to settle");
	};
	const publish = (value: RecentWindow) => {
		fixture.cache?.setQueryData(key, value);
		fixture.query.data = fixture.cache?.getQueryData(key);
		return render();
	};
	const click = async (label: "work.showMore" | "nav.refresh") => {
		const matches = elements(output, Button).filter((button) => button.props.children === label);
		assert.equal(matches.length, 1);
		assert.ok(matches[0]);
		invoke(matches[0].props.onClick, { currentTarget: label === "work.showMore" ? control : retryControl });
		for (let attempt = 0; attempt < 30 && fixture.cache?.isFetching(); attempt++) await Promise.resolve();
		// Let the component's awaited fetch/finally retire its pending-action guard.
		await Promise.resolve();
		await Promise.resolve();
		fixture.query.data = fixture.cache?.getQueryData(key);
		return render();
	};
	const focus = (scope: Scope) => {
		const row = rows.get(scopeKey(scope));
		const link = row?.children[0];
		assert.ok(link);
		documentStub.activeElement = link;
		invoke(only(output, "section").props.onFocusCapture, { target: link });
		render();
		return { row, link };
	};
	return {
		props,
		root,
		region,
		top,
		bottom,
		control,
		retryControl,
		rows,
		render,
		publish,
		more: () => click("work.showMore"),
		click,
		focus,
		get output() {
			return output;
		},
		hold(owner: string, held: boolean, element?: ElementStub) {
			only(output, WindowInteractionContext.Provider).props.value?.(owner, held, element as HTMLElement | undefined);
			render();
		},
		beforeLayout(run: () => void, ready = () => true) {
			afterCommit = { run, ready };
		},
		beforeCommit(run: () => void, ready: (next: React.ReactNode) => boolean) {
			beforeCommit = { run, ready };
		},
	};
}
beforeEach(() => {
	fixture.cells = [];
	fixture.cursor = 0;
	fixture.dirty = false;
	fixture.layouts = [];
	fixture.effects = [];
	fixture.collapsed = false;
	fixture.dragging = false;
	fixture.options = undefined;
	fixture.virtualizer = undefined;
	fixture.scrollOffset = 0;
	fixture.query = {
		data: undefined,
		dataUpdatedAt: 1,
		isFetching: false,
		isError: false,
		isPending: false,
		refetch: vi.fn(),
	};
	fixture.cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	fixture.client = { call: vi.fn(async () => page(50)) as AppClient["call"], observe: vi.fn() };
	const body = node("body");
	documentStub = Object.assign(new EventTarget(), { visibilityState: "visible", body, activeElement: body });
	observers.length = 0;
	vi.stubGlobal("document", documentStub);
	vi.stubGlobal("Element", ElementStub);
	vi.stubGlobal("IntersectionObserver", ObserverStub);
});
afterEach(() => {
	for (const cell of fixture.cells) cell.cleanup?.();
	fixture.cache?.clear();
	vi.unstubAllGlobals();
});

test("non-last Recent begins with ten, reveals five, and offers only Show more", async () => {
	const ui = harness();
	ui.publish(snapshot([page()]));
	assert.equal(ui.rows.size, 10);
	assert.equal(only(ui.output, Button).props.children, "work.showMore");
	assert.equal(
		observers.some((observer) => observer.observed.has(ui.bottom)),
		false,
	);
	await ui.more();
	assert.equal(ui.rows.size, 15);
	assert.ok(fixture.client);
	assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
	assert.equal(elements(ui.output, Button).length, 1, "No First page or Show less interaction is added");
});
test("last-section sentinel reveals five once per observation without a Show more control", () => {
	const ui = harness({ last: true });
	ui.publish(snapshot([page()]));
	assert.equal(elements(ui.output, Button).length, 0);
	const observer = observers.findLast((entry) => entry.observed.has(ui.bottom));
	assert.ok(observer);
	observer.callback([{ target: ui.bottom, isIntersecting: true }]);
	ui.render();
	assert.equal(ui.rows.size, 15);
	assert.equal(observer.observed.has(ui.bottom), false);
	assert.ok(observers.findLast((entry) => entry.observed.has(ui.bottom)));
});
test("missing IntersectionObserver uses the same explicit paging fallback", async () => {
	vi.stubGlobal("IntersectionObserver", undefined);
	const ui = harness({ last: true });
	ui.publish(snapshot([page()]));
	assert.equal(only(ui.output, Button).props.children, "work.showMore");
	await ui.more();
	assert.equal(ui.rows.size, 15);
});
test.each([11, 16])("terminal %i-row remainder avoids an extra single-row interaction", async (length) => {
	const ui = harness();
	ui.publish(snapshot([page(0, length, null)]));
	if (length === 16) {
		assert.equal(ui.rows.size, 10);
		await ui.more();
	}
	assert.equal(fixture.virtualizer?.options.count, length);
	assert.equal(ui.rows.size, Math.min(length, 17));
	fixture.scrollOffset = 144;
	ui.render();
	assert.ok(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: String(length - 1) })));
	assert.equal(elements(ui.output, Button).length, 0);
});
test.each(["document", "surface", "collapsed", "dragging"] as const)(
	"%s fences stale sentinel callbacks and automatic query reads",
	(fence) => {
		const ui = harness({ last: true });
		ui.publish(snapshot([page(0, 10)]));
		const observer = observers.findLast((entry) => entry.observed.has(ui.bottom));
		assert.ok(observer);
		assert.ok(fixture.cache);
		const cancel = vi.spyOn(fixture.cache, "cancelQueries");
		if (fence === "document") {
			documentStub.visibilityState = "hidden";
			documentStub.dispatchEvent(new Event("visibilitychange"));
		}
		if (fence === "surface") ui.props.visible = false;
		if (fence === "collapsed") fixture.collapsed = true;
		if (fence === "dragging") fixture.dragging = true;
		ui.render();
		observer.callback([{ target: ui.bottom, isIntersecting: true }]);
		ui.render();
		assert.ok(fixture.client);
		assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
		assert.equal(fixture.virtualizer?.options.count, 10, "Hidden views preserve revealed metadata");
		assert.equal(ui.rows.size, fence === "dragging" ? 10 : 0);
		if (fence !== "dragging") {
			assert.equal(fixture.options?.enabled, false);
			assert.deepEqual(cancel.mock.calls, [[{ queryKey: key, exact: true }]]);
		}
	},
);
test("visibility cancellation aborts outstanding continuation before a sparse follow-up read", async () => {
	let resolve: ((value: SidebarWindowResult) => void) | undefined;
	let signal: AbortSignal | undefined;
	const call = vi.fn((_method: string, _request: SidebarWindowRequest, supplied?: AbortSignal) => {
		signal = supplied;
		return new Promise<SidebarWindowResult>((done) => {
			resolve = done;
		});
	});
	fixture.client = { call: call as AppClient["call"], observe: vi.fn() };
	const ui = harness();
	ui.publish(snapshot([page(0, 10)]));
	invoke(only(ui.output, Button).props.onClick, { currentTarget: ui.control });
	assert.equal(call.mock.calls.length, 1);
	assert.equal(signal?.aborted, false);
	documentStub.visibilityState = "hidden";
	documentStub.dispatchEvent(new Event("visibilitychange"));
	ui.render();
	assert.equal(signal?.aborted, true);
	resolve?.(page(50, 0));
	for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
	assert.equal(call.mock.calls.length, 1);
	assert.equal(fixture.virtualizer?.options.count, 10);
	assert.equal(ui.rows.size, 0);
	documentStub.visibilityState = "visible";
	documentStub.dispatchEvent(new Event("visibilitychange"));
	ui.render();
	assert.equal(ui.rows.size, 10);
});
test.each(["focus", "menu", "dialog"] as const)(
	"a hidden document retains the same measured keyed %s owner without hidden reads",
	(owner) => {
		const ui = harness();
		ui.publish(snapshot([page()]));
		const scope = { workspaceId: "physical", conversationId: "7" };
		const original = ui.rows.get(scopeKey(scope));
		const link = original?.children[0];
		assert.ok(original && link && fixture.virtualizer);
		if (owner === "focus") ui.focus(scope);
		else ui.hold(`row:${owner}`, true, link);
		fixture.virtualizer.resizeItem(0, 48);
		ui.render();
		const before = elements(ui.output, "li").find((row) => row.key === scopeKey(scope));
		assert.ok(before);
		const height = only(ui.output, "ul").props.style?.height;
		const more = only(ui.output, Button);
		// The fixture models row-local state by keyed owner identity. This marker
		// does not claim a mounted Rename dialog or native input acceptance test.
		const localRenameState = new WeakMap<ElementStub, { text: string }>();
		const unsaved = { text: "Unsubmitted rename text" };
		localRenameState.set(original, unsaved);
		documentStub.visibilityState = "hidden";
		documentStub.dispatchEvent(new Event("visibilitychange"));
		ui.render();
		invoke(more.props.onClick, { currentTarget: ui.control });
		ui.render();
		assert.equal(fixture.options?.enabled, false);
		assert.equal(fixture.virtualizer.options.enabled, false);
		assert.equal(ui.rows.size, 1, "Only the real protected owner remains while observations are disabled");
		assert.equal(ui.rows.get(scopeKey(scope)), original);
		assert.equal(original.children[0], link);
		assert.equal(link.isConnected, true);
		assert.equal(localRenameState.get(original), unsaved);
		assert.deepEqual(
			elements(ui.output, "li").find((row) => row.key === scopeKey(scope))?.props.style,
			before.props.style,
		);
		assert.equal(only(ui.output, "ul").props.style?.height, height);
		if (owner === "focus") assert.equal(documentStub.activeElement, link);
		assert.ok(fixture.client);
		assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
		assert.equal(fixture.query.refetch.mock.calls.length, 0);
		documentStub.visibilityState = "visible";
		documentStub.dispatchEvent(new Event("visibilitychange"));
		ui.render();
		assert.equal(ui.rows.size, 10);
		assert.equal(ui.rows.get(scopeKey(scope)), original);
		assert.equal(localRenameState.get(original)?.text, "Unsubmitted rename text");
		assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
		assert.equal(fixture.query.refetch.mock.calls.length, 0);
	},
);
test("menu and dialog owners hold staging and paging independently until both release", async () => {
	const ui = harness();
	ui.publish(snapshot([page()]));
	ui.hold("row:menu", true);
	ui.hold("row:dialog", true);
	await ui.more();
	assert.equal(ui.rows.size, 10);
	ui.publish(snapshot([page(100)]));
	assert.ok(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "0" })));
	ui.hold("row:menu", false);
	assert.ok(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "0" })));
	ui.hold("row:dialog", false);
	assert.equal(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "0" })), false);
	assert.ok(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "100" })));
});
test("ordinary focus permits 600 loaded rows, bounds mounted nodes and retains the original canonical row", async () => {
	const focused = { workspaceId: "physical", conversationId: "0" };
	const call = vi.fn(async (_method: string, request: SidebarWindowRequest) => {
		const start = request.position.kind === "continue" ? Number(request.position.cursor) : 0;
		const result = page(start, 50, String(start + 50));
		if (request.retainedScopes?.some((scope) => scopeKey(scope) === scopeKey(focused))) {
			const row = page(0, 1).items[0];
			assert.ok(row);
			row.conversation.title = "Runtime-renamed focused row";
			result.retained.eligible = [{ row, placement: start ? "before" : "inside" }];
		}
		return result;
	});
	fixture.client = { call: call as AppClient["call"], observe: vi.fn() };
	const initial = await readRecentWindow(fixture.client, view, "active", new AbortController().signal);
	const ui = harness();
	ui.publish(initial);
	const original = ui.focus(focused);
	for (let index = 0; index < 118; index++) await ui.more();
	assert.equal(call.mock.calls.length, 12);
	assert.equal(fixture.query.data?.pages.flatMap((page) => page.items).length, 600);
	assert.equal(fixture.query.data?.pages[0]?.items[0]?.conversation.conversationId, "0");
	assert.equal(fixture.virtualizer?.options.count, 600);
	fixture.scrollOffset = 550 * 31;
	ui.render();
	assert.equal(ui.rows.get(scopeKey(focused)), original.row);
	assert.equal(documentStub.activeElement, original.link);
	assert.equal(original.link.isConnected, true);
	assert.equal(ui.rows.size, 24, "The first focused row also retains its next keyboard neighbor");
	assert.ok(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "1" })));
	assert.deepEqual(call.mock.calls.at(-1)?.[1].retainedScopes, [focused]);
	assert.equal(fixture.query.refetch.mock.calls.length, 0);
	// A replacement publication may exclude the focused row from its ordinary
	// range. Its authoritative retained proof must update the same keyed owner.
	const replacement = page(500);
	assert.ok(fixture.query.data);
	replacement.retained = fixture.query.data.retained;
	fixture.scrollOffset = 0;
	ui.publish(snapshot([replacement]));
	assert.equal(ui.rows.get(scopeKey(focused)), original.row);
	assert.equal(documentStub.activeElement, original.link);
	const retained = elements(ui.output, ConversationPreview).find(
		(row) => scopeKey(row.props.conversation) === scopeKey(focused),
	);
	assert.equal(retained?.props.conversation.title, "Runtime-renamed focused row");
});
test("selected retention uses complete canonical scope and never invents an unproved extra row", () => {
	const selected = { workspaceId: "physical", conversationId: "500" };
	const next = page();
	const wrong = page(500, 1, null, "other").items[0];
	const right = page(500, 1).items[0];
	assert.ok(wrong && right);
	next.retained.eligible = [
		{ row: wrong, placement: "before" },
		{ row: right, placement: "after" },
	];
	const ui = harness({ selected });
	ui.publish(snapshot([next]));
	assert.equal(ui.rows.size, 11);
	assert.equal(ui.rows.has(scopeKey(wrong.conversation)), false);
	assert.ok(ui.rows.has(scopeKey(selected)));
	assert.equal(elements(ui.output, ConversationPreview).at(-1)?.props.conversation.workspaceId, "physical");
	ui.props.selected = { workspaceId: "missing", conversationId: "500" };
	ui.render();
	assert.equal(ui.rows.size, 10);
	assert.equal(fixture.query.refetch.mock.calls.length, 1);
});
test("focused candidate lacking canonical proof is staged rather than dropping the original row", () => {
	const ui = harness();
	ui.publish(snapshot([page()]));
	const focused = { workspaceId: "physical", conversationId: "0" };
	const original = ui.focus(focused);
	const next = page(100);
	const wrong = page(0, 1, null, "other").items[0];
	assert.ok(wrong);
	next.retained.eligible = [{ row: wrong, placement: "before" }];
	ui.publish(snapshot([next]));
	assert.equal(ui.rows.get(scopeKey(focused)), original.row);
	assert.equal(documentStub.activeElement, original.link);
	assert.equal(fixture.query.refetch.mock.calls.length, 1);
});
test.each(["alias", "region", "offscreen-alias", "hidden-alias", "newer-focus"] as const)(
	"authoritative unavailable retirement restores %s without stealing newer focus",
	(target) => {
		const ui = harness();
		ui.publish(snapshot([page()]));
		const focused = { workspaceId: "physical", conversationId: "0" };
		const original = ui.focus(focused);
		const alias = node("link");
		alias.dataset = focused;
		alias.parent = ui.root;
		if (target === "offscreen-alias") alias.getBoundingClientRect = () => ({ top: 500, bottom: 536 });
		if (target === "hidden-alias") alias.hidden = true;
		if (target !== "region") ui.root.children.push(alias);
		const wrong = node("link");
		wrong.dataset = { ...focused, workspaceId: "other" };
		wrong.parent = ui.root;
		ui.root.children.unshift(wrong);
		const outside = node("outside");
		if (target === "newer-focus")
			ui.beforeLayout(
				() => {
					documentStub.activeElement = outside;
				},
				() => !original.link.isConnected,
			);
		const next = page(100);
		next.retained.unavailable = [{ scope: focused, reason: "ineligible" }];
		ui.publish(snapshot([next]));
		assert.equal(original.link.isConnected, false);
		assert.equal(
			documentStub.activeElement,
			target === "alias" ? alias : target === "newer-focus" ? outside : ui.region,
		);
		assert.equal(wrong.focus.mock.calls.length, 0);
		if (target === "offscreen-alias" || target === "hidden-alias") assert.equal(alias.focus.mock.calls.length, 0);
		if (target === "newer-focus") {
			assert.equal(alias.focus.mock.calls.length, 0);
			assert.equal(ui.region.focus.mock.calls.length, 0);
		}
	},
);

test("terminal Show more removal returns its still-owned keyboard focus to Recent", async () => {
	const ui = harness();
	ui.publish(snapshot([page(0, 16, null)]));
	documentStub.activeElement = ui.control;
	await ui.more();
	assert.equal(ui.control.isConnected, false);
	assert.equal(documentStub.activeElement, ui.region);
	assert.deepEqual(ui.region.focus.mock.calls, [[{ preventScroll: true }]]);
});

test("terminal Show more retirement cannot reclaim focus after a later blur", async () => {
	let resolve: ((value: SidebarWindowResult) => void) | undefined;
	fixture.client = {
		call: vi.fn(
			() =>
				new Promise<SidebarWindowResult>((done) => {
					resolve = done;
				}),
		) as AppClient["call"],
		observe: vi.fn(),
	};
	const ui = harness();
	ui.publish(snapshot([page(0, 10)]));
	documentStub.activeElement = ui.control;
	const button = only(ui.output, Button);
	invoke(button.props.onClick, { currentTarget: ui.control });
	invoke(button.props.onBlur, { relatedTarget: null });
	documentStub.activeElement = documentStub.body;
	resolve?.(page(10, 1, null));
	for (let attempt = 0; attempt < 30; attempt++) await Promise.resolve();
	fixture.query.data = fixture.cache?.getQueryData(key);
	ui.render();
	assert.equal(ui.control.isConnected, false);
	assert.equal(documentStub.activeElement, documentStub.body);
	assert.equal(ui.region.focus.mock.calls.length, 0);
});

test("in-flight Show more stays focusable but cannot issue another paging action", () => {
	const ui = harness();
	ui.publish(snapshot([page(0, 10)]));
	fixture.query.isFetching = true;
	ui.render();
	const button = only(ui.output, Button);
	assert.equal(button.props.disabled, undefined);
	assert.equal(button.props["aria-disabled"], true);
	documentStub.activeElement = ui.control;
	invoke(button.props.onClick, { currentTarget: ui.control });
	assert.equal(documentStub.activeElement, ui.control);
	assert.ok(fixture.client);
	assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
});

test("scrolling 600 revealed rows keeps only viewport, overscan and exact menu/dialog owners mounted", async () => {
	const ui = harness();
	ui.publish(
		snapshot(Array.from({ length: 12 }, (_, index) => page(index * 50, 50, index < 11 ? String(index + 1) : null))),
	);
	for (let index = 0; index < 118; index++) await ui.more();
	assert.equal(fixture.virtualizer?.options.count, 600);
	assert.equal(fixture.virtualizer?.getTotalSize(), 18599);
	assert.equal(ui.rows.size, 17);
	const menuScope = { workspaceId: "physical", conversationId: "0" };
	const dialogScope = { workspaceId: "physical", conversationId: "1" };
	const menuRow = ui.rows.get(scopeKey(menuScope));
	const dialogRow = ui.rows.get(scopeKey(dialogScope));
	assert.ok(menuRow && dialogRow);
	ui.hold("row:menu", true, menuRow.children[0]);
	ui.hold("row:dialog", true, dialogRow.children[0]);
	fixture.scrollOffset = 500 * 31;
	ui.render();
	assert.equal(ui.rows.size, 24);
	assert.equal(ui.rows.get(scopeKey(menuScope)), menuRow);
	assert.equal(ui.rows.get(scopeKey(dialogScope)), dialogRow);
	assert.equal(fixture.virtualizer?.getTotalSize(), 18599, "Protected nodes cannot alter the measured list extent");
	ui.hold("row:menu", false);
	assert.equal(ui.rows.size, 23);
	assert.equal(ui.rows.has(scopeKey(menuScope)), false);
	assert.equal(ui.rows.get(scopeKey(dialogScope)), dialogRow);
	ui.hold("row:dialog", false);
	assert.equal(ui.rows.size, 22);
	assert.equal(ui.rows.has(scopeKey(dialogScope)), false);
	assert.ok(fixture.client);
	assert.equal(
		vi.mocked(fixture.client.call).mock.calls.length,
		0,
		"Scrolling loaded metadata never requests another catalog window",
	);
});

test("virtual rows expose canonical measurement keys and measured extent without phantom catalog rows", async () => {
	const ui = harness();
	ui.publish(snapshot([page()]));
	assert.ok(fixture.virtualizer);
	assert.equal(fixture.virtualizer.options.estimateSize(0), 30);
	assert.equal(fixture.virtualizer.options.gap, 1);
	assert.equal(
		fixture.virtualizer.getTotalSize(),
		309,
		"Unrevealed metadata does not become a global scrollbar estimate",
	);
	const initialList = only(ui.output, "ul");
	assert.equal(initialList.props.style?.height, 341);
	for (const row of elements(initialList.props.children, "li").filter(
		(item) => item.props.className === "conversation-nav-item",
	)) {
		const index = Number(Reflect.get(row.props, "data-index"));
		assert.equal(row.key, scopeKey({ workspaceId: "physical", conversationId: String(index) }));
		assert.equal(row.props.ref, fixture.virtualizer.measureElement);
		assert.deepEqual(row.props.style, { position: "absolute", top: index * 31, width: "100%" });
	}
	fixture.virtualizer.resizeItem(0, 48);
	ui.render();
	assert.equal(fixture.virtualizer.getTotalSize(), 327);
	assert.equal(only(ui.output, "ul").props.style?.height, 359);
	await ui.more();
	assert.equal(fixture.virtualizer.options.count, 15);
	assert.equal(fixture.virtualizer.getTotalSize(), 482);
	assert.equal(only(ui.output, "ul").props.style?.height, 514);
	fixture.virtualizer.resizeItem(1, 62);
	ui.render();
	assert.equal(fixture.virtualizer.getTotalSize(), 514, "Larger configured font rows remain measured, not fixed-pitch");
	const measured = fixture.virtualizer.getVirtualItems();
	for (let index = 1; index < measured.length; index++) {
		const previous = measured[index - 1];
		const current = measured[index];
		assert.ok(previous && current);
		assert.equal(current.start - previous.end, 1, "Each measured pair receives exactly one gap");
	}
});

function pausedWindow(previous: RecentWindow, reason: "budget" | "publication" = "budget"): RecentWindow {
	const candidate = page(100, 5, "105");
	return {
		...previous,
		paused: true,
		refreshPaused: reason,
		refresh: {
			pages: [candidate],
			retained: candidate.retained,
			position: { kind: "continue", cursor: "105" },
			start: { kind: "head" },
			fallbacks: [],
			targetCount: previous.pages.flatMap((entry) => entry.items).length,
			attemptReads: 40,
			attemptBudget: 40,
			restarts: reason === "publication" ? 1 : 0,
		},
	};
}

test("paused replacement preserves the revealed slice and allows only already-loaded Show more", async () => {
	const ui = harness();
	const previous = snapshot([page()], "next");
	ui.publish(previous);
	for (let index = 0; index < 6; index++) await ui.more();
	assert.equal(fixture.virtualizer?.options.count, 40);
	ui.publish(pausedWindow(previous));
	assert.equal(
		fixture.virtualizer?.options.count,
		40,
		"Same-revision paused state must not replay the earlier next action",
	);
	assert.deepEqual(
		elements(ui.output, Button).map((button) => button.props.children),
		["nav.refresh", "work.showMore"],
	);
	await ui.more();
	await ui.more();
	assert.equal(fixture.virtualizer?.options.count, 50);
	assert.deepEqual(
		elements(ui.output, Button).map((button) => button.props.children),
		["nav.refresh"],
	);
	assert.equal(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "100" })), false);
	assert.ok(fixture.client);
	assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
	assert.equal(
		observers.some((observer) => observer.observed.size > 0),
		false,
	);
});

test.each(["budget", "publication"] as const)(
	"explicit Refresh resumes %s staging and only publishes a complete coherent replacement",
	async (reason) => {
		const call = vi.fn(async (_method: string, request: SidebarWindowRequest) => {
			assert.deepEqual(request.position, { kind: "continue", cursor: "105" });
			return page(105, 45, null);
		});
		fixture.client = { call: call as AppClient["call"], observe: vi.fn() };
		const ui = harness();
		ui.publish(pausedWindow(snapshot([page()]), reason));
		documentStub.activeElement = ui.retryControl;
		await ui.click("nav.refresh");
		assert.equal(call.mock.calls.length, 1);
		assert.equal(fixture.query.data?.refreshPaused, undefined);
		assert.equal(fixture.query.data?.refresh, undefined);
		assert.equal(fixture.query.data?.pages.flatMap((entry) => entry.items).length, 50);
		assert.equal(fixture.query.data?.pages[0]?.items[0]?.conversation.conversationId, "100");
		assert.equal(ui.rows.has(scopeKey({ workspaceId: "physical", conversationId: "0" })), false);
		assert.equal(ui.retryControl.isConnected, false);
		assert.equal(documentStub.activeElement, ui.region);
		assert.equal(
			fixture.query.refetch.mock.calls.length,
			0,
			"Explicit retry must use the query's renewed-budget operation",
		);
	},
);

test.each(["document", "surface", "collapsed", "dragging", "menu", "fetching"] as const)(
	"%s blocks a stale paused Refresh callback",
	(fence) => {
		const ui = harness();
		ui.publish(pausedWindow(snapshot([page(0, 10, null)])));
		const refresh = only(ui.output, Button);
		assert.equal(refresh.props.children, "nav.refresh");
		if (fence === "document") {
			documentStub.visibilityState = "hidden";
			documentStub.dispatchEvent(new Event("visibilitychange"));
		}
		if (fence === "surface") ui.props.visible = false;
		if (fence === "collapsed") fixture.collapsed = true;
		if (fence === "dragging") fixture.dragging = true;
		if (fence === "menu") ui.hold("row:menu", true);
		if (fence === "fetching") fixture.query.isFetching = true;
		ui.render();
		invoke(refresh.props.onClick, { currentTarget: ui.retryControl });
		assert.ok(fixture.client);
		assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
		assert.equal(fixture.query.refetch.mock.calls.length, 0);
	},
);

test.each(["surface", "collapsed"] as const)(
	"%s releases query and local committed staging without renewing its paused budget",
	async (fence) => {
		const ui = harness();
		ui.publish(pausedWindow(snapshot([page(0, 10, null)])));
		const before = fixture.query.data;
		assert.ok(before?.refresh);
		assert.equal(before.refresh.pages[0]?.items[0]?.conversation.conversationId, "100");
		// Locate the committed useState cell by its actual published value, not by
		// a fragile hook ordinal. Query cache eviction alone cannot release it.
		const committedCell = fixture.cells.find((cell) => cell.value === before);
		assert.ok(committedCell);
		const cancel = vi.spyOn(fixture.cache as QueryClient, "cancelQueries");
		if (fence === "surface") ui.props.visible = false;
		else fixture.collapsed = true;
		ui.render();
		for (let index = 0; index < 10; index++) await Promise.resolve();
		assert.deepEqual(cancel.mock.calls, [[{ queryKey: key, exact: true }]]);
		const saved = fixture.cache?.getQueryData<RecentWindow>(key);
		assert.ok(saved);
		assert.equal(saved.refresh, undefined);
		assert.equal(saved.refreshPaused, "budget");
		assert.equal(saved.revision, before.revision);
		assert.equal(saved.pages.flatMap((entry) => entry.items).length, 10);
		assert.equal(saved.pages[0]?.items[0]?.conversation.conversationId, "0");
		assert.notEqual(committedCell.value, before);
		assert.deepEqual(
			committedCell.value,
			saved,
			"The hidden commit guard must not leave staged replacement pages retained by React state",
		);
		fixture.query.data = saved;
		ui.render();
		assert.deepEqual(committedCell.value, saved);
		assert.equal(ui.rows.size, 0);
		if (fence === "surface") ui.props.visible = true;
		else fixture.collapsed = false;
		ui.render();
		assert.equal(only(ui.output, Button).props.children, "nav.refresh");
		assert.equal(ui.rows.size, 10);
	},
);

test.each(["observer", "fallback"] as const)(
	"head-origin refresh keeps inserted prefix and its original anchor without a fabricated previous %s control",
	async (mode) => {
		if (mode === "fallback") vi.stubGlobal("IntersectionObserver", undefined);
		const ui = harness();
		ui.publish(snapshot([page()]));
		await ui.more();
		assert.equal(fixture.virtualizer?.options.count, 15);
		const scope = { workspaceId: "physical", conversationId: "0" };
		const original = ui.focus(scope);
		assert.ok(original.row);
		const anchor = original.row;
		// Explicit geometry seam: inserting two keyed rows above this anchor moves
		// its measured box by72px, until production restoration adjusts scrollTop.
		anchor.getBoundingClientRect = () => {
			const top = 20 + ui.region.children.indexOf(anchor) * 36 - ui.root.scrollTop;
			return { top, bottom: top + 36 };
		};
		assert.equal(anchor.getBoundingClientRect().top, 20);
		const head = page(-2, 50, "continuation:48");
		head.previousCursor = null;
		const replacement = snapshot([head, page(48, 2, "continuation:50")]);
		replacement.revision = 2;
		ui.publish(replacement);
		assert.equal(fixture.virtualizer?.options.count, 17, "The two newest rows remain part of the revealed head prefix");
		assert.deepEqual(
			[0, 1, 2].map((index) => fixture.virtualizer?.options.getItemKey(index)),
			[-2, -1, 0].map((id) => scopeKey({ workspaceId: "physical", conversationId: String(id) })),
		);
		assert.equal(
			fixture.virtualizer?.options.getItemKey(16),
			scopeKey({ workspaceId: "physical", conversationId: "14" }),
		);
		assert.deepEqual(
			ui.region.children.slice(0, 3).map((row) => row.dataset.conversationId),
			["-2", "-1", "0"],
		);
		assert.equal(ui.rows.get(scopeKey(scope)), anchor);
		assert.equal(documentStub.activeElement, original.link);
		assert.equal(original.link.isConnected, true);
		assert.equal(ui.root.scrollTop, 72);
		assert.equal(
			anchor.getBoundingClientRect().top,
			20,
			"The original visible canonical anchor keeps its measured offset",
		);
		const previous = elements(ui.output, "li").find((item) => item.key === "previous");
		assert.ok(previous);
		assert.equal(previous.props["aria-hidden"], true);
		assert.equal(elements(previous, Button).length, 0);
		assert.equal(
			observers.some((observer) => observer.observed.has(ui.top)),
			false,
		);
		assert.equal(only(ui.output, Button).props.children, "work.showMore");
		assert.equal(fixture.query.refetch.mock.calls.length, 0);
	},
);

test("replacement captures at most three painted rows at commit time and restores a surviving neighbor's current measured offset", () => {
	const ui = harness();
	const previous = page();
	ui.publish(snapshot([previous]));
	const oldFirst = ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "1" }));
	const survivor = ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "2" }));
	const fourth = ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "4" }));
	assert.ok(oldFirst && survivor && fourth);
	for (const row of ui.rows.values()) {
		const index = Number(row.dataset.conversationId);
		const top = index === 0 ? -80 : 20 + (index - 1) * 50;
		row.getBoundingClientRect = () => ({ top, bottom: top + 36 });
	}
	let beforeOffset = 70;
	let committed = false;
	survivor.getBoundingClientRect = () => {
		const top = (committed ? 210 : beforeOffset) - ui.root.scrollTop;
		return { top, bottom: top + 36 };
	};
	const beyondBudget = vi.fn(() => ({ top: 170, bottom: 206 }));
	fourth.getBoundingClientRect = beyondBudget;
	const replacement = page(100, 10, null);
	const survivorData = previous.items[2];
	assert.ok(survivorData);
	replacement.items.unshift(survivorData);
	replacement.previousCursor = null;
	ui.hold("menu", true);
	ui.publish(snapshot([replacement]));
	assert.equal(oldFirst.isConnected, true);
	beforeOffset = 95;
	ui.beforeLayout(
		() => {
			committed = true;
		},
		() => !oldFirst.isConnected,
	);
	ui.hold("menu", false);
	assert.equal(beyondBudget.mock.calls.length, 0, "Only the three genuinely painted candidates may be sampled");
	assert.equal(ui.rows.get(scopeKey(survivorData.conversation)), survivor);
	assert.equal(ui.root.scrollTop, 115, "Use95px measured just before commit, not70px from the earlier arrival");
	assert.equal(survivor.getBoundingClientRect().top, 95);
	assert.equal(elements(ui.output, "output").filter((output) => output.props.className === "sr-only").length, 0);
});

test.each(["newest", "empty"] as const)(
	"full replacement without surviving painted rows aligns the %s target without changing selection, draft or focus",
	(kind) => {
		assert.ok(fixture.client);
		const selected = { workspaceId: "physical", conversationId: "0" };
		const local = new LocalState();
		local.write("draft.physical/0", "Unsent text remains unchanged");
		const draft = local.valueSnapshot("draft.physical/0");
		const catalog = new CatalogSession(fixture.client, local);
		const catalogState = catalog.getSnapshot();
		const ui = harness({ selected, catalog });
		ui.publish(snapshot([page()]));
		const oldFirst = ui.rows.get(scopeKey(selected));
		assert.ok(oldFirst);
		const outside = node("outside");
		documentStub.activeElement = outside;
		ui.root.scrollTop = 200;
		const replacement = page(100, kind === "newest" ? 50 : 0, null);
		replacement.previousCursor = null;
		replacement.retained.unavailable = [{ scope: selected, reason: "ineligible" }];
		let target: ElementStub | undefined;
		ui.beforeLayout(
			() => {
				target =
					kind === "newest" ? ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "100" })) : ui.region;
				assert.ok(target);
				target.getBoundingClientRect = () => {
					const top = 500 - ui.root.scrollTop;
					return { top, bottom: top + 36 };
				};
			},
			() => !oldFirst.isConnected,
		);
		ui.publish(snapshot([replacement]));
		assert.ok(target);
		assert.equal(ui.root.scrollTop, 500);
		assert.equal(target.getBoundingClientRect().top, 0);
		assert.equal(
			fixture.virtualizer?.options.count,
			kind === "newest" ? 10 : 0,
			"Replacing 50 fetched rows must not silently reveal beyond the original ten-row prefix",
		);
		const notices = elements(ui.output, "output").filter((output) => output.props.className === "sr-only");
		assert.equal(notices.length, 1);
		assert.equal(
			notices[0]?.props.children,
			kind === "newest"
				? "Recent changed; showing the newest loaded chats."
				: "Recent changed; no chats match this view.",
		);
		assert.equal(ui.props.selected, selected);
		assert.equal(vi.mocked(ui.props.onSelect).mock.calls.length, 0);
		assert.deepEqual(local.valueSnapshot("draft.physical/0"), draft);
		assert.equal(catalog.getSnapshot(), catalogState);
		assert.equal(documentStub.activeElement, outside);
		assert.equal(ui.region.focus.mock.calls.length, 0);
		assert.equal(vi.mocked(fixture.client.call).mock.calls.length, 0);
	},
);

test("a full replacement wholly outside the scroll viewport neither scrolls nor announces a reset", () => {
	const ui = harness();
	ui.publish(snapshot([page()]));
	const oldFirst = ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "0" }));
	assert.ok(oldFirst);
	ui.root.scrollTop = 200;
	ui.region.getBoundingClientRect = () => ({ top: 600, bottom: 1000 });
	for (const row of ui.rows.values()) row.getBoundingClientRect = () => ({ top: 620, bottom: 656 });
	ui.beforeLayout(
		() => {
			for (const row of ui.rows.values()) row.getBoundingClientRect = () => ({ top: 620, bottom: 656 });
		},
		() => !oldFirst.isConnected,
	);
	const replacement = page(100, 10, null);
	replacement.previousCursor = null;
	ui.publish(snapshot([replacement]));
	assert.equal(ui.root.scrollTop, 200);
	assert.equal(elements(ui.output, "output").filter((output) => output.props.className === "sr-only").length, 0);
	assert.equal(vi.mocked(ui.props.onSelect).mock.calls.length, 0);
});

for (const strategy of ["anchor", "newest"] as const) {
	test.each(["wheel", "touchmove", "pointerdown", "keydown"] as const)(
		`new %s intent between capture and commit cancels ${strategy} scroll restoration`,
		(kind) => {
			const ui = harness();
			ui.publish(snapshot([page()]));
			const oldFirst = ui.rows.get(scopeKey({ workspaceId: "physical", conversationId: "0" }));
			assert.ok(oldFirst);
			const outside = node("outside");
			documentStub.activeElement = outside;
			ui.root.scrollTop = 100;
			let captured = false;
			oldFirst.getBoundingClientRect = () => {
				const top = captured ? 300 - ui.root.scrollTop : 20;
				return { top, bottom: top + 36 };
			};
			const replacement = strategy === "anchor" ? page(-2, 50) : page(100, 10, null);
			replacement.previousCursor = null;
			const inserted = strategy === "anchor" ? "-2" : "100";
			ui.beforeCommit(
				() => {
					captured = true;
					ui.root.dispatchEvent(new Event(kind));
					ui.root.scrollTop = 175;
				},
				(output) =>
					elements(output, ConversationPreview).some((row) => row.props.conversation.conversationId === inserted),
			);
			ui.publish(snapshot([replacement]));
			assert.equal(captured, true);
			assert.equal(ui.root.scrollTop, 175);
			assert.equal(elements(ui.output, "output").filter((output) => output.props.className === "sr-only").length, 0);
			assert.equal(documentStub.activeElement, outside);
			assert.equal(vi.mocked(ui.props.onSelect).mock.calls.length, 0);
		},
	);
}

test("real-cache missing focused proof may pause once without a refetch loop and leaves explicit Retry visible", async () => {
	let resolveCandidate: ((value: SidebarWindowResult) => void) | undefined;
	let phase: "candidate" | "sparse" | "retry" = "candidate";
	const focused = { workspaceId: "physical", conversationId: "0" };
	const call = vi.fn((_method: string, request: SidebarWindowRequest) => {
		if (phase === "candidate")
			return new Promise<SidebarWindowResult>((resolve) => {
				resolveCandidate = resolve;
			});
		assert.deepEqual(request.retainedScopes, [focused]);
		if (phase === "sparse") return Promise.resolve(page(100, 0, "proof-next"));
		const replacement = page(100, 50, null);
		const retained = page(0, 1).items[0];
		assert.ok(retained);
		replacement.retained.eligible = [{ row: retained, placement: "before" }];
		return Promise.resolve(replacement);
	});
	fixture.client = { call: call as AppClient["call"], observe: vi.fn() };
	const ui = harness({ last: true });
	ui.publish(snapshot([page()]));
	assert.ok(fixture.cache && fixture.options);
	const observer = new QueryObserver<RecentWindow>(fixture.cache, {
		...fixture.options,
		enabled: false,
		gcTime: Infinity,
	});
	const release = observer.subscribe((result) => {
		fixture.query.data = result.data;
		fixture.query.isFetching = result.isFetching;
		fixture.query.isError = result.isError;
		fixture.query.isPending = result.isPending;
		fixture.query.dataUpdatedAt = result.dataUpdatedAt;
	});
	const proofRequests: ReturnType<typeof observer.refetch>[] = [];
	fixture.query.refetch.mockImplementation(() => {
		const request = observer.refetch({ cancelRefetch: false });
		proofRequests.push(request);
		return request;
	});
	try {
		const candidateRequest = observer.refetch({ cancelRefetch: false });
		assert.equal(fixture.query.isFetching, true);
		ui.render();
		const original = ui.focus(focused);
		phase = "sparse";
		resolveCandidate?.(page(100, 50));
		await candidateRequest;
		ui.render();
		assert.equal(fixture.query.refetch.mock.calls.length, 1);
		assert.ok(proofRequests[0]);
		await proofRequests[0];
		ui.render();
		assert.equal(fixture.query.data?.refreshPaused, "budget");
		assert.equal(fixture.query.data?.pages[0]?.items[0]?.conversation.conversationId, "100");
		assert.equal(fixture.query.isFetching, false);
		assert.equal(call.mock.calls.length, 41);
		for (let index = 0; index < 10; index++) {
			ui.render();
			await Promise.resolve();
		}
		assert.equal(
			fixture.query.refetch.mock.calls.length,
			1,
			"A paused missing-proof candidate cannot restart its own proof request",
		);
		assert.equal(call.mock.calls.length, 41);
		assert.equal(fixture.query.isFetching, false);
		assert.equal(ui.rows.get(scopeKey(focused)), original.row);
		assert.equal(original.link.isConnected, true);
		assert.equal(documentStub.activeElement, original.link);
		assert.ok(elements(ui.output, Button).some((button) => button.props.children === "nav.refresh"));
		assert.ok(elements(ui.output, Button).some((button) => button.props.children === "work.showMore"));
		for (let index = 0; index < 8; index++) await ui.more();
		assert.equal(fixture.virtualizer?.options.count, 50);
		assert.equal(call.mock.calls.length, 41, "Paused local reveals cannot resume a cursor or proof request");
		assert.equal(fixture.query.refetch.mock.calls.length, 1);
		assert.equal(ui.rows.get(scopeKey(focused)), original.row);
		assert.equal(documentStub.activeElement, original.link);
		assert.equal(
			elements(ui.output, Button).some((button) => button.props.children === "work.showMore"),
			false,
		);
		phase = "retry";
		await ui.click("nav.refresh");
		assert.equal(call.mock.calls.length, 42);
		assert.equal(fixture.query.data?.refreshPaused, undefined);
		assert.equal(fixture.query.isFetching, false);
		assert.equal(fixture.query.refetch.mock.calls.length, 1);
		assert.equal(ui.rows.get(scopeKey(focused)), original.row);
		assert.equal(documentStub.activeElement, original.link);
		assert.equal(
			elements(ui.output, Button).some((button) => button.props.children === "nav.refresh"),
			false,
		);
	} finally {
		release();
		observer.destroy();
	}
});
