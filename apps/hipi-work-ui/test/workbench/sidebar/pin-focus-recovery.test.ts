import assert from "node:assert/strict";
import type { AppClient, SidebarPage } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, test, vi } from "vitest";
import { navigationKey, navigationOptions } from "../../../src/features/workbench/sidebar/navigation-query.ts";
import {
	navigationFocusSettled,
	PinFocusRecovery,
	projectFocusSettled,
} from "../../../src/features/workbench/sidebar/pin-focus-recovery.ts";

class FocusDocument extends EventTarget {
	activeElement: FocusElement | null = null;
	defaultView = Object.assign(new EventTarget(), {
		getComputedStyle: (element: FocusElement) => ({ visibility: element.visibility }),
	});
}
class FocusElement {
	ownerDocument: FocusDocument;
	dataset: Record<string, string> = {};
	rows: FocusElement[] = [];
	regions: FocusElement[] = [];
	isConnected = true;
	hidden = false;
	disabled = false;
	visibility = "visible";
	pinnedProject = false;
	matches() {
		return this.disabled;
	}
	focus = vi.fn(() => {
		this.ownerDocument.activeElement = this;
	});
	constructor(document: FocusDocument) {
		this.ownerDocument = document;
	}
	closest(selector: string) {
		if (selector === "[data-project-id]") return this.dataset.projectId ? this : null;
		if (selector === "[data-pinned-project]") return this.pinnedProject ? this : null;
		return this.hidden ? this : null;
	}
	getClientRects() {
		return this.hidden ? [] : [{}];
	}
	querySelectorAll(selector: string) {
		return selector === ".conversation-link" || selector === ".project-open" ? this.rows : this.regions;
	}
}
class Observer {
	static instances: Observer[] = [];
	active = true;
	callback: () => void;
	observe = vi.fn((_root: unknown, _options: MutationObserverInit) => {});
	disconnect = vi.fn(() => {
		this.active = false;
	});
	constructor(callback: () => void) {
		this.callback = callback;
		Observer.instances.push(this);
	}
	deliver() {
		if (this.active) this.callback();
	}
}
// Deliberate DOM seam: real QueryObserver settlement is paired with explicit DOM
// commits. Browser mutation delivery and painted focus remain native acceptance.
const dom = (element: FocusElement) => element as unknown as HTMLElement;
const scope = { workspaceId: "project", conversationId: "chat" };
const page = (): SidebarPage => ({
	items: [],
	nextCursor: null,
	coverage: { generation: "one", membershipGeneration: 1, state: "ready", completedAt: 1, nextCursor: null },
});
const cleanup: (() => void)[] = [];
beforeEach(() => {
	Observer.instances = [];
	vi.stubGlobal("MutationObserver", Observer);
});
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.unstubAllGlobals();
});

function setup() {
	const document = new FocusDocument();
	const root = new FocusElement(document);
	const fallback = new FocusElement(document); // navigation list survives disappearance of the last pin section
	const region = new FocusElement(document);
	root.regions = [region];
	const target = new FocusElement(document);
	target.dataset = { ...scope, sidebarLocation: "recent" };
	const cache = new QueryClient();
	const key = navigationKey({ kind: "recent" }, "active");
	region.dataset.sidebarQuery = JSON.stringify(key);
	cache.setQueryData(key, { pages: [page()], cursors: [undefined] }, { updatedAt: 1 });
	region.dataset.sidebarUpdatedAt = "1";
	let resolve!: (page: SidebarPage) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<SidebarPage>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	const response = { promise, resolve, reject };
	const client: AppClient = { call: vi.fn(() => response.promise) as AppClient["call"], observe: vi.fn() };
	const observer = new QueryObserver(cache, {
		...navigationOptions(cache, client, { kind: "recent" }, "active"),
		staleTime: Infinity,
	});
	const unsubscribe = observer.subscribe(() => {});
	const recovery = new PinFocusRecovery();
	cleanup.push(() => {
		recovery.cancel();
		unsubscribe();
		cache.clear();
	});
	const pending = cache.invalidateQueries({ queryKey: key, exact: true });
	const settled = () => navigationFocusSettled(dom(root), cache, scope);
	recovery.restore(scope, dom(root), dom(fallback), true, settled);
	const mutation = Observer.instances.at(-1);
	assert.ok(mutation);
	const commit = (withTarget: boolean) => {
		root.rows = withTarget ? [target] : [];
		region.dataset.sidebarUpdatedAt = String(cache.getQueryState(key)?.dataUpdatedAt);
		mutation.deliver();
	};
	return { document, root, fallback, target, recovery, mutation, response, pending, settled, commit };
}

test("last pin removal waits for async canonical query DOM settlement, then focuses exactly once", async () => {
	const state = setup();
	assert.equal(state.document.activeElement, state.fallback);
	assert.equal(state.target.focus.mock.calls.length, 0);
	state.response.resolve(page());
	await state.pending;
	assert.equal(
		state.settled(),
		false,
		"Cache success before its DOM commit is not permission to abandon focus recovery",
	);
	state.mutation.deliver();
	assert.equal(state.mutation.active, true);
	state.commit(true);
	assert.equal(state.document.activeElement, state.target);
	assert.deepEqual(state.target.focus.mock.calls, [[{ preventScroll: true }]]);
	assert.equal(state.mutation.active, false);
	state.mutation.deliver();
	assert.equal(state.target.focus.mock.calls.length, 1);
});

test.each(["pointerdown", "keydown", "focusin", "window-blur"])(
	"new %s intent cancels delayed focus restoration",
	async (kind) => {
		const state = setup();
		const elsewhere = new FocusElement(state.document);
		if (kind === "focusin") state.document.activeElement = elsewhere;
		if (kind === "window-blur") state.document.defaultView.dispatchEvent(new Event("blur"));
		else state.document.dispatchEvent(new Event(kind));
		assert.equal(state.mutation.active, false);
		state.response.resolve(page());
		await state.pending;
		state.commit(true);
		assert.equal(state.target.focus.mock.calls.length, 0);
	},
);

test("completed filtered/no-target query releases the observer at the stable fallback", async () => {
	const state = setup();
	state.response.resolve(page());
	await state.pending;
	state.commit(false);
	assert.equal(state.document.activeElement, state.fallback);
	assert.equal(state.mutation.active, false);
});

test("a failed invalidation read terminates pending focus at the stable fallback", async () => {
	const state = setup();
	state.response.reject(new Error("OFFLINE"));
	await state.pending;
	state.commit(false);
	assert.equal(state.settled(), true);
	assert.equal(state.mutation.active, false);
	assert.equal(state.document.activeElement, state.fallback);
});

test("navigation/collapse/disposal cleanup cancels obsolete Scope and is Strict Mode repeat-safe", async () => {
	const state = setup();
	state.recovery.cancel();
	state.recovery.cancel();
	state.response.resolve(page());
	await state.pending;
	state.commit(true);
	assert.equal(state.target.focus.mock.calls.length, 0);
	assert.equal(state.mutation.disconnect.mock.calls.length, 1);
	state.root.rows = [];
	state.recovery.restore({ ...scope, conversationId: "new" }, dom(state.root), dom(state.fallback), true, () => false);
	const current = Observer.instances.at(-1);
	assert.ok(current);
	state.root.rows = [state.target];
	current.deliver();
	assert.equal(state.target.focus.mock.calls.length, 0, "Late old-Scope DOM cannot acquire the new owner");
	state.root.hidden = true;
	current.deliver();
	assert.equal(current.active, false);
});

test("an already present canonical row is restored immediately without an observer", () => {
	const document = new FocusDocument();
	const root = new FocusElement(document);
	const target = new FocusElement(document);
	target.dataset = { ...scope, sidebarLocation: "workspace" };
	root.rows = [target];
	new PinFocusRecovery().restore(scope, dom(root), dom(root), false, () => true);
	assert.equal(document.activeElement, target);
	assert.equal(Observer.instances.length, 0);
});

test.each(["hidden", "disabled", "visibility"])("ineligible %s canonical rows never acquire focus", async (kind) => {
	const state = setup();
	if (kind === "visibility") state.target.visibility = "hidden";
	else if (kind === "disabled") state.target.disabled = true;
	else state.target.hidden = true;
	state.response.resolve(page());
	await state.pending;
	state.commit(true);
	assert.equal(state.target.focus.mock.calls.length, 0);
	assert.equal(state.document.activeElement, state.fallback);
	assert.equal(state.mutation.active, false);
});

test("project unpin waits for project catalog DOM commit after cache settles, then finds exact logical row", async () => {
	const document = new FocusDocument(),
		root = new FocusElement(document),
		fallback = new FocusElement(document),
		region = new FocusElement(document),
		target = new FocusElement(document);
	target.dataset = { projectId: "logical", workspaceId: "adapter" };
	root.regions = [region];
	const key = ["projects", "pages"];
	const cache = new QueryClient();
	cache.setQueryData(key, { pages: [] }, { updatedAt: 1 });
	region.dataset.projectQuery = JSON.stringify(key);
	region.dataset.projectUpdatedAt = "1";
	const response = Promise.withResolvers<{ pages: unknown[] }>();
	const observer = new QueryObserver(cache, { queryKey: key, queryFn: () => response.promise, staleTime: Infinity });
	const unsubscribe = observer.subscribe(() => {});
	const pending = cache.invalidateQueries({ queryKey: key, exact: true });
	const recovery = new PinFocusRecovery();
	const settled = () => projectFocusSettled(dom(root), cache);
	recovery.restoreProject("logical", dom(root), dom(fallback), true, settled);
	const mutation = Observer.instances.at(-1);
	assert.ok(mutation);
	assert.ok(mutation.observe.mock.calls[0]?.[1].attributeFilter?.includes("data-project-updated-at"));
	response.resolve({ pages: [] });
	await pending;
	assert.equal(settled(), false, "Current cache without matching committed timestamp cannot retire focus intent");
	mutation.deliver();
	assert.equal(mutation.active, true);
	const wrong = new FocusElement(document);
	wrong.dataset = { projectId: "other", workspaceId: "adapter" };
	root.rows = [wrong];
	mutation.deliver();
	assert.equal(wrong.focus.mock.calls.length, 0);
	root.rows = [target];
	region.dataset.projectUpdatedAt = String(cache.getQueryState(key)?.dataUpdatedAt);
	mutation.deliver();
	assert.equal(document.activeElement, target);
	assert.equal(mutation.active, false);
	assert.equal(target.focus.mock.calls.length, 1);
	recovery.cancel();
	unsubscribe();
	cache.clear();
});
test("project restore rejects pinned or hidden aliases and cancels upon new intent", () => {
	const document = new FocusDocument(),
		root = new FocusElement(document),
		fallback = new FocusElement(document),
		target = new FocusElement(document);
	target.dataset = { projectId: "logical" };
	target.pinnedProject = true;
	root.rows = [target];
	const recovery = new PinFocusRecovery();
	recovery.restoreProject("logical", dom(root), dom(fallback), true, () => false);
	assert.equal(document.activeElement, fallback);
	const mutation = Observer.instances.at(-1);
	assert.ok(mutation);
	document.dispatchEvent(new Event("pointerdown"));
	target.pinnedProject = false;
	mutation.deliver();
	assert.equal(target.focus.mock.calls.length, 0);
	recovery.cancel();
});

test("a project metadata-only no-row commit retires waiting focus before unrelated later insertion", () => {
	const document = new FocusDocument(),
		root = new FocusElement(document),
		fallback = new FocusElement(document),
		region = new FocusElement(document);
	root.regions = [region];
	const key = ["projects", "pages"];
	const cache = new QueryClient();
	cache.setQueryData(key, { pages: [] }, { updatedAt: 2 });
	region.dataset.projectQuery = JSON.stringify(key);
	region.dataset.projectUpdatedAt = "1";
	const observer = new QueryObserver(cache, {
		queryKey: key,
		queryFn: async () => ({ pages: [] }),
		staleTime: Infinity,
	});
	const unsubscribe = observer.subscribe(() => {});
	const recovery = new PinFocusRecovery();
	recovery.restoreProject("logical", dom(root), dom(fallback), true, () => projectFocusSettled(dom(root), cache));
	const mutation = Observer.instances.at(-1);
	assert.ok(mutation);
	assert.equal(mutation.active, true);
	region.dataset.projectUpdatedAt = "2";
	mutation.deliver();
	assert.equal(mutation.active, false);
	const late = new FocusElement(document);
	late.dataset = { projectId: "logical" };
	root.rows = [late];
	mutation.deliver();
	assert.equal(late.focus.mock.calls.length, 0);
	recovery.cancel();
	unsubscribe();
	cache.clear();
});
