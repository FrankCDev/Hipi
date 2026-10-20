import assert from "node:assert/strict";
import type { Scope } from "@hipi/work-runtime/contracts";
import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SidebarLocation } from "../../../src/features/workbench/sidebar/selection-owner.ts";
import {
	SidebarAliasRegistry,
	SidebarSelectionProvider,
	useSidebarAlias,
} from "../../../src/features/workbench/sidebar/selection-provider.tsx";

const scope: Scope = { workspaceId: "workspace", conversationId: "conversation" };
const pinned: SidebarLocation = { kind: "pinned" };
const recent: SidebarLocation = { kind: "recent" };
const workspace: SidebarLocation = { kind: "workspace", workspaceId: "workspace" };
const observedAttributes = ["hidden", "inert", "aria-hidden", "disabled", "aria-disabled", "class", "style"];

// This bounded adapter exercises the production registry, not native DOM layout,
// browser mutation delivery, React mounting, focus behavior, or painted frames.
// Only the final SSR tests use an actual React renderer, without module mocks.
class AdapterElement {
	readonly ownerDocument: { defaultView: AdapterWindow };
	readonly attributes = new Map<string, string>();
	readonly children: AdapterElement[] = [];
	readonly focus = vi.fn();
	readonly scrollIntoView = vi.fn();
	parentElement: AdapterElement | null = null;
	connected = true;
	disabled = false;
	display = "block";
	visibility: string | null = null;
	rect = { x: 0, y: 0, width: 240, height: 32 };

	constructor(view: AdapterWindow, parent?: AdapterElement) {
		this.ownerDocument = { defaultView: view };
		parent?.append(this);
	}
	append(child: AdapterElement) {
		child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
		child.parentElement = this;
		this.children.push(child);
	}
	get isConnected(): boolean {
		return this.connected && (this.parentElement?.isConnected ?? true);
	}
	contains(target: AdapterElement): boolean {
		return target === this || (!!target.parentElement && this.contains(target.parentElement));
	}
	closest(selector: string): AdapterElement | null {
		assert.equal(selector, '[inert], [hidden], [aria-hidden="true"]');
		if (this.attributes.has("inert") || this.attributes.has("hidden") || this.attributes.get("aria-hidden") === "true")
			return this;
		return this.parentElement?.closest(selector) ?? null;
	}
	matches(selector: string): boolean {
		assert.equal(selector, ':disabled, [aria-disabled="true"], [aria-haspopup]:not([aria-haspopup="false"])');
		return (
			this.disabled ||
			this.attributes.has("disabled") ||
			this.attributes.get("aria-disabled") === "true" ||
			(this.attributes.has("aria-haspopup") && this.attributes.get("aria-haspopup") !== "false")
		);
	}
	getClientRects(): readonly (typeof this.rect)[] {
		for (let element: AdapterElement | null = this; element; element = element.parentElement)
			if (
				element.display === "none" ||
				element.attributes.has("hidden") ||
				element.attributes.get("class") === "test-display-none"
			)
				return [];
		return [this.rect];
	}
	compareDocumentPosition(other: AdapterElement): number {
		if (other === this) return 0;
		let root: AdapterElement = this;
		while (root.parentElement) root = root.parentElement;
		const order: AdapterElement[] = [];
		const visit = (element: AdapterElement) => {
			order.push(element);
			for (const child of element.children) visit(child);
		};
		visit(root);
		if (!order.includes(other)) return 1;
		return order.indexOf(this) < order.indexOf(other) ? 4 : 2;
	}
}

class AdapterWindow extends EventTarget {
	getComputedStyle(element: AdapterElement) {
		for (let ancestor: AdapterElement | null = element; ancestor; ancestor = ancestor.parentElement)
			if (ancestor.visibility !== null) return { visibility: ancestor.visibility };
		return { visibility: "visible" };
	}
}

class AdapterObserver {
	static instances: AdapterObserver[] = [];
	readonly targets = new Map<AdapterElement, MutationObserverInit>();
	readonly observe = vi.fn((target: AdapterElement, options: MutationObserverInit) => {
		this.targets.set(target, options);
	});
	readonly disconnect = vi.fn(() => this.targets.clear());
	readonly deliver: () => void;

	constructor(callback: () => void) {
		this.deliver = callback;
		AdapterObserver.instances.push(this);
	}
}

// The only structural cast is at the deliberately partial DOM adapter boundary.
function dom(element: AdapterElement): HTMLButtonElement {
	return element as unknown as HTMLButtonElement;
}

function mutate(target: AdapterElement, attribute?: string) {
	const recipients = AdapterObserver.instances.filter((observer) => {
		const options = observer.targets.get(target);
		return attribute ? options?.attributes && options.attributeFilter?.includes(attribute) : options?.childList;
	});
	for (const observer of recipients) observer.deliver();
}

const registries: SidebarAliasRegistry[] = [];
function harness(preferred: SidebarLocation | null = null) {
	const view = new AdapterWindow();
	const addListener = vi.spyOn(view, "addEventListener");
	const removeListener = vi.spyOn(view, "removeEventListener");
	const documentRoot = new AdapterElement(view);
	const root = new AdapterElement(view, documentRoot);
	const unrelated = new AdapterElement(view, documentRoot);
	const rootRef = { current: dom(root) as HTMLElement | null };
	const registry = new SidebarAliasRegistry(scope, preferred, rootRef);
	registries.push(registry);
	return {
		view,
		root,
		rootRef,
		unrelated,
		documentRoot,
		registry,
		addListener,
		removeListener,
		row: (parent = root) => new AdapterElement(view, parent),
	};
}

beforeEach(() => {
	AdapterObserver.instances = [];
	vi.stubGlobal("MutationObserver", AdapterObserver);
	vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });
});
afterEach(() => {
	for (const registry of registries.splice(0)) registry.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("preferred aliases win over registration and DOM order, and setPreferred reconciles the existing registry", () => {
	const ui = harness(pinned);
	const first = ui.row();
	const second = ui.row();
	const third = ui.row();
	ui.registry.register("recent", recent, dom(first));
	ui.registry.register("workspace", workspace, dom(second));
	ui.registry.register("pinned", pinned, dom(third));
	assert.equal(ui.registry.getSnapshot(), "pinned");
	ui.registry.setPreferred(workspace);
	assert.equal(ui.registry.getSnapshot(), "workspace");
	ui.registry.setPreferred(recent);
	assert.equal(ui.registry.getSnapshot(), "recent");
	ui.registry.setPreferred({ kind: "workspace", workspaceId: "other-workspace" });
	assert.equal(ui.registry.getSnapshot(), "recent");
	ui.registry.setPreferred(null);
	assert.equal(ui.registry.getSnapshot(), "recent");
	assert.deepEqual(ui.registry.scope, scope);
});

test("fallback follows current DOM order after reordering rather than registration or previous ownership", () => {
	const ui = harness();
	const first = ui.row();
	const second = ui.row();
	ui.registry.register("second", recent, dom(second));
	ui.registry.register("first", workspace, dom(first));
	assert.equal(ui.registry.getSnapshot(), "first");
	ui.root.append(first);
	mutate(ui.root);
	assert.equal(ui.registry.getSnapshot(), "second");
	ui.registry.setPreferred(pinned);
	assert.equal(ui.registry.getSnapshot(), "second", "an absent preferred location still uses current DOM order");
});

test("multiple rows at the preferred location also resolve in current DOM order", () => {
	const ui = harness(pinned);
	const first = ui.row();
	const second = ui.row();
	ui.registry.register("second", pinned, dom(second));
	ui.registry.register("first", pinned, dom(first));
	assert.equal(ui.registry.getSnapshot(), "first");
	ui.root.append(first);
	mutate(ui.root);
	assert.equal(ui.registry.getSnapshot(), "second");
});

test("collapsing an ancestor chooses the fallback and re-expanding restores the unchanged preference", () => {
	const ui = harness(workspace);
	const fallback = ui.row();
	const section = ui.row();
	const preferred = ui.row(section);
	ui.registry.register("fallback", pinned, dom(fallback));
	ui.registry.register("preferred", workspace, dom(preferred));
	assert.equal(ui.registry.getSnapshot(), "preferred");
	section.attributes.set("hidden", "");
	mutate(section, "hidden");
	assert.equal(ui.registry.getSnapshot(), "fallback");
	section.attributes.delete("hidden");
	mutate(section, "hidden");
	assert.equal(ui.registry.getSnapshot(), "preferred");
});

for (const target of ["row", "ancestor"] as const) {
	for (const attribute of ["hidden", "inert", "aria-hidden"] as const) {
		test(`${attribute} on the ${target} excludes the preferred row and its removal restores ownership`, () => {
			const ui = harness(workspace);
			const fallback = ui.row();
			const section = ui.row();
			const preferred = ui.row(section);
			ui.registry.register("fallback", recent, dom(fallback));
			ui.registry.register("preferred", workspace, dom(preferred));
			const changed = target === "row" ? preferred : section;
			changed.attributes.set(attribute, attribute === "aria-hidden" ? "true" : "");
			mutate(changed, attribute);
			assert.equal(ui.registry.getSnapshot(), "fallback");
			changed.attributes.delete(attribute);
			mutate(changed, attribute);
			assert.equal(ui.registry.getSnapshot(), "preferred");
		});
	}
}

for (const state of ["disabled", "aria-disabled", "class", "display", "visibility"] as const) {
	test(`${state} changes are re-evaluated through the alias observer`, () => {
		const ui = harness(workspace);
		const fallback = ui.row();
		const section = ui.row();
		const preferred = ui.row(section);
		ui.registry.register("fallback", recent, dom(fallback));
		ui.registry.register("preferred", workspace, dom(preferred));
		const target = state === "class" || state === "display" || state === "visibility" ? section : preferred;
		const attribute = state === "display" || state === "visibility" ? "style" : state;
		if (state === "disabled") preferred.disabled = true;
		else if (state === "aria-disabled") preferred.attributes.set(state, "true");
		else if (state === "class") section.attributes.set("class", "test-display-none");
		else if (state === "display") section.display = "none";
		else section.visibility = "hidden";
		mutate(target, attribute);
		assert.equal(ui.registry.getSnapshot(), "fallback");
		preferred.disabled = false;
		preferred.attributes.delete("aria-disabled");
		section.attributes.delete("class");
		section.display = "block";
		section.visibility = null;
		mutate(target, attribute);
		assert.equal(ui.registry.getSnapshot(), "preferred");
	});
}

test("explicit false ARIA values and offscreen rendered rows remain eligible without viewport intersection", () => {
	const ui = harness(pinned);
	const fallback = ui.row();
	const preferred = ui.row();
	preferred.rect.y = -1000;
	preferred.attributes.set("aria-hidden", "false");
	preferred.attributes.set("aria-disabled", "false");
	preferred.attributes.set("aria-haspopup", "false");
	ui.registry.register("fallback", recent, dom(fallback));
	ui.registry.register("preferred", pinned, dom(preferred));
	assert.equal(ui.registry.getSnapshot(), "preferred");
	preferred.rect.y = 100000;
	ui.view.dispatchEvent(new Event("resize"));
	assert.equal(ui.registry.getSnapshot(), "preferred");
});

test("an auxiliary popup control cannot become the active navigation alias", () => {
	const ui = harness(pinned);
	const popup = ui.row();
	popup.attributes.set("aria-haspopup", "menu");
	const navigation = ui.row();
	ui.registry.register("popup", pinned, dom(popup));
	ui.registry.register("navigation", recent, dom(navigation));
	assert.equal(ui.registry.getSnapshot(), "navigation");
});

test("all-ineligible rows retain only a still-registered owner, and removing it clears the stale ID", () => {
	const ui = harness(pinned);
	const first = ui.row();
	const second = ui.row();
	const unregister = ui.registry.register("first", pinned, dom(first));
	second.attributes.set("hidden", "");
	ui.registry.register("second", recent, dom(second));
	first.attributes.set("hidden", "");
	mutate(first, "hidden");
	assert.equal(ui.registry.getSnapshot(), "first");
	unregister();
	assert.equal(ui.registry.getSnapshot(), null);
	second.attributes.delete("hidden");
	mutate(second, "hidden");
	assert.equal(ui.registry.getSnapshot(), "second");
});

test("removing outer modal aria-hidden discovers the fallback after the preferred alias unmounts", () => {
	const ui = harness(pinned);
	const preferred = ui.row();
	const fallback = ui.row();
	fallback.attributes.set("hidden", "");
	const unregisterPreferred = ui.registry.register("preferred", pinned, dom(preferred));
	ui.registry.register("fallback", recent, dom(fallback));
	assert.equal(ui.registry.getSnapshot(), "preferred");
	// Modal isolation can hide an ancestor outside the sidebar's root boundary.
	ui.documentRoot.attributes.set("aria-hidden", "true");
	mutate(ui.documentRoot, "aria-hidden");
	unregisterPreferred();
	assert.equal(ui.registry.getSnapshot(), null);
	fallback.attributes.delete("hidden");
	mutate(fallback, "hidden");
	assert.equal(ui.registry.getSnapshot(), null, "the outer modal isolation still excludes the fallback");
	ui.documentRoot.attributes.delete("aria-hidden");
	mutate(ui.documentRoot, "aria-hidden");
	assert.equal(ui.registry.getSnapshot(), "fallback", "modal close must not require a resize or another registration");
});

test("disconnected preferred rows fall back and reconnect without a new registration", () => {
	const ui = harness(pinned);
	const first = ui.row();
	const fallback = ui.row();
	ui.registry.register("first", pinned, dom(first));
	ui.registry.register("fallback", recent, dom(fallback));
	first.connected = false;
	mutate(ui.root);
	assert.equal(ui.registry.getSnapshot(), "fallback");
	first.connected = true;
	mutate(ui.root);
	assert.equal(ui.registry.getSnapshot(), "first");
});

test("foreign roots cannot supply aliases and the root ref becoming unavailable cannot admit new ownership", () => {
	const ui = harness(pinned);
	const outside = ui.row(ui.unrelated);
	const inside = ui.row();
	ui.registry.register("outside", pinned, dom(outside));
	assert.equal(ui.registry.getSnapshot(), null);
	assert.equal(AdapterObserver.instances.length, 0);
	const unregister = ui.registry.register("inside", recent, dom(inside));
	assert.equal(ui.registry.getSnapshot(), "inside");
	ui.rootRef.current = null;
	ui.registry.reconcile();
	assert.equal(ui.registry.getSnapshot(), "inside", "registered but ineligible previous ownership is retained");
	unregister();
	assert.equal(ui.registry.getSnapshot(), null);
});

test("observation follows each alias's complete ancestor chain without observing unrelated subtrees", () => {
	const ui = harness();
	const section = ui.row();
	const row = ui.row(section);
	const unrelatedChild = ui.row(ui.unrelated);
	ui.registry.register("row", recent, dom(row));
	const observer = AdapterObserver.instances[0];
	assert.ok(observer);
	assert.deepEqual(
		observer.observe.mock.calls,
		[row, section, ui.root, ui.documentRoot].map((element) => [
			element,
			{ attributes: true, attributeFilter: observedAttributes, childList: true },
		]),
	);
	assert.equal(observer.targets.has(ui.documentRoot), true);
	assert.equal(observer.targets.has(ui.unrelated), false);
	assert.equal(observer.targets.has(unrelatedChild), false);
	mutate(unrelatedChild, "style");
	mutate(ui.unrelated, "class");
	mutate(ui.documentRoot, "data-unrelated");
	assert.equal(AdapterObserver.instances.length, 1);
	assert.equal(observer.disconnect.mock.calls.length, 0);
});

test("reparenting refreshes the exact ancestor chain and retires the obsolete observer", () => {
	const ui = harness(pinned);
	const oldSection = ui.row();
	const newSection = ui.row();
	const preferred = ui.row(oldSection);
	const fallback = ui.row();
	ui.registry.register("preferred", pinned, dom(preferred));
	ui.registry.register("fallback", recent, dom(fallback));
	const oldObserver = AdapterObserver.instances[0];
	assert.ok(oldObserver);
	newSection.attributes.set("hidden", "");
	newSection.append(preferred);
	mutate(oldSection);
	assert.equal(oldObserver.disconnect.mock.calls.length, 1);
	assert.equal(oldObserver.targets.size, 0);
	const current = AdapterObserver.instances.at(-1);
	assert.ok(current);
	assert.deepEqual([...current.targets.keys()], [preferred, newSection, ui.root, ui.documentRoot]);
	assert.equal(ui.registry.getSnapshot(), "fallback");
	newSection.attributes.delete("hidden");
	mutate(newSection, "hidden");
	assert.equal(ui.registry.getSnapshot(), "preferred");
	const count = AdapterObserver.instances.length;
	mutate(oldSection, "hidden");
	assert.equal(AdapterObserver.instances.length, count);
});

test("cleanup from an obsolete registration cannot remove its replacement or resurrect an observer", () => {
	const ui = harness(pinned);
	const oldRow = ui.row();
	const replacement = ui.row();
	const unregisterOld = ui.registry.register("same", pinned, dom(oldRow));
	const oldObserver = AdapterObserver.instances[0];
	assert.ok(oldObserver);
	const unregisterNew = ui.registry.register("same", pinned, dom(replacement));
	const newObserver = AdapterObserver.instances.at(-1);
	assert.ok(newObserver);
	assert.equal(oldObserver.targets.size, 0);
	unregisterOld();
	oldObserver.deliver();
	assert.equal(AdapterObserver.instances.length, 2);
	assert.equal(ui.registry.getSnapshot(), "same");
	assert.equal(newObserver.targets.has(replacement), true);
	assert.equal(ui.removeListener.mock.calls.length, 0);
	unregisterNew();
	newObserver.deliver();
	assert.equal(ui.registry.getSnapshot(), null);
	assert.equal(AdapterObserver.instances.length, 2);
	assert.equal(ui.removeListener.mock.calls.length, 1);
});

test("the last unregister releases the exact shared resize listener and late callbacks cannot resubscribe", () => {
	const ui = harness();
	const first = ui.row();
	const second = ui.row();
	const unregisterFirst = ui.registry.register("first", pinned, dom(first));
	const unregisterSecond = ui.registry.register("second", recent, dom(second));
	const observers = [...AdapterObserver.instances];
	assert.deepEqual(ui.addListener.mock.calls, [["resize", ui.registry.reconcile]]);
	unregisterFirst();
	assert.equal(ui.removeListener.mock.calls.length, 0);
	unregisterSecond();
	assert.deepEqual(ui.removeListener.mock.calls, [["resize", ui.registry.reconcile]]);
	for (const observer of observers) {
		assert.equal(observer.disconnect.mock.calls.length, 1);
		assert.equal(observer.targets.size, 0);
		observer.deliver();
	}
	ui.view.dispatchEvent(new Event("resize"));
	assert.equal(AdapterObserver.instances.length, 2);
	assert.equal(ui.registry.getSnapshot(), null);
});

test("clear releases owned resources and supports the cleanup/setup sequence used by Strict Mode", () => {
	const ui = harness(pinned);
	const row = ui.row();
	const oldCleanup = ui.registry.register("row", pinned, dom(row));
	const oldObserver = AdapterObserver.instances[0];
	assert.ok(oldObserver);
	ui.registry.clear();
	assert.equal(ui.registry.getSnapshot(), null);
	assert.equal(oldObserver.disconnect.mock.calls.length, 1);
	assert.deepEqual(ui.removeListener.mock.calls, [["resize", ui.registry.reconcile]]);
	const newCleanup = ui.registry.register("row", pinned, dom(row));
	oldCleanup();
	oldObserver.deliver();
	assert.equal(ui.registry.getSnapshot(), "row");
	assert.equal(AdapterObserver.instances.length, 2);
	assert.equal(ui.addListener.mock.calls.length, 2);
	assert.equal(ui.removeListener.mock.calls.length, 1);
	newCleanup();
	ui.registry.clear();
	assert.equal(ui.registry.getSnapshot(), null);
	assert.equal(ui.removeListener.mock.calls.length, 2);
});

test("subscriptions publish only ownership changes, unsubscribe precisely, and selection never requests focus or scroll", () => {
	const ui = harness(pinned);
	const first = ui.row();
	const second = ui.row();
	const notify = vi.fn();
	const unsubscribe = ui.registry.subscribe(notify);
	ui.registry.register("first", recent, dom(first));
	ui.registry.register("second", pinned, dom(second));
	assert.equal(notify.mock.calls.length, 2);
	ui.registry.reconcile();
	ui.registry.setPreferred(pinned);
	ui.view.dispatchEvent(new Event("resize"));
	assert.equal(notify.mock.calls.length, 2);
	second.attributes.set("hidden", "");
	mutate(second, "hidden");
	assert.equal(notify.mock.calls.length, 3);
	ui.registry.setPreferred(recent);
	assert.equal(notify.mock.calls.length, 3);
	unsubscribe();
	second.attributes.delete("hidden");
	mutate(second, "hidden");
	ui.registry.setPreferred(pinned);
	ui.registry.clear();
	assert.equal(notify.mock.calls.length, 3);
	for (const element of [first, second, ui.root, ui.documentRoot]) {
		assert.equal(element.focus.mock.calls.length, 0);
		assert.equal(element.scrollIntoView.mock.calls.length, 0);
	}
});

function ServerRow({ rowScope, location }: { rowScope: Scope; location: SidebarLocation }) {
	const alias = useSidebarAlias(rowScope, location);
	return (
		<button ref={alias.ref} type="button" aria-current={alias.active ? "page" : undefined}>
			{rowScope.conversationId || "New conversation"}
		</button>
	);
}

test("real React SSR composes the provider and route hooks without claiming DOM-backed active ownership", () => {
	const ui = harness(pinned);
	const register = vi.spyOn(SidebarAliasRegistry.prototype, "register");
	const html = renderToStaticMarkup(
		<StrictMode>
			<SidebarSelectionProvider scope={scope} preferredLocation={pinned} rootRef={ui.rootRef}>
				<ServerRow rowScope={scope} location={pinned} />
				<ServerRow rowScope={scope} location={recent} />
				<ServerRow rowScope={{ ...scope, workspaceId: "other-workspace" }} location={workspace} />
				<ServerRow rowScope={{ workspaceId: "workspace", conversationId: "" }} location={recent} />
			</SidebarSelectionProvider>
		</StrictMode>,
	);
	assert.equal((html.match(/<button/g) ?? []).length, 4);
	assert.match(html, /New conversation/);
	assert.doesNotMatch(html, /aria-current|aria-pressed|aria-selected/);
	assert.equal(register.mock.calls.length, 0);
	assert.equal(AdapterObserver.instances.length, 0);
	assert.equal(ui.addListener.mock.calls.length, 0);
	assert.equal(ui.registry.getServerSnapshot(), null);
});

test("real React composition rejects an alias outside its owning provider", () => {
	assert.throws(
		() => renderToStaticMarkup(<ServerRow rowScope={scope} location={pinned} />),
		/Sidebar aliases require their navigation provider/,
	);
});
