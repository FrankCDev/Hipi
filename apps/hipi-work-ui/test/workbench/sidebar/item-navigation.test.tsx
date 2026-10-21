import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { appKeybindingLabels } from "../../../src/app/keybinding-labels.ts";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS, matchesBinding } from "../../../src/app/keybindings.ts";
import { SidebarItemNavigation } from "../../../src/features/workbench/sidebar/item-navigation.ts";

// Bounded DOM/event adapter. These tests verify the production owner and its
// scheduling, not browser layout, native accelerator delivery or React mounting.
class View extends EventTarget {
	frames = new Map<number, FrameRequestCallback>();
	serial = 0;
	requestAnimationFrame = (callback: FrameRequestCallback) => {
		const id = ++this.serial;
		this.frames.set(id, callback);
		return id;
	};
	cancelAnimationFrame = (id: number) => this.frames.delete(id);
	getComputedStyle(element: ElementAdapter) {
		return element.style;
	}
	flush() {
		const pending = [...this.frames.values()];
		this.frames.clear();
		for (const callback of pending) callback(0);
	}
}
class DocumentAdapter extends EventTarget {
	defaultView = new View();
	modal = false;
	querySelector() {
		return this.modal ? {} : null;
	}
}
class ElementAdapter extends EventTarget {
	ownerDocument: DocumentAdapter;
	parentElement: ElementAdapter | null;
	children: ElementAdapter[] = [];
	attributes = new Map<string, string>();
	isConnected = true;
	visible = true;
	editable = false;
	style = { visibility: "visible", overflowY: "visible", scrollPaddingTop: "0", scrollPaddingBottom: "0" };
	rect = { top: 0, height: 30 };
	offsetHeight = 30;
	clientHeight = 30;
	clientTop = 0;
	scrollTop = 0;
	click = vi.fn();
	focus = vi.fn();
	scrollTo = vi.fn();
	constructor(doc: DocumentAdapter, parent: ElementAdapter | null = null) {
		super();
		this.ownerDocument = doc;
		this.parentElement = parent;
		parent?.children.push(this);
	}
	contains(element: ElementAdapter): boolean {
		return element === this || (!!element.parentElement && this.contains(element.parentElement));
	}
	getClientRects() {
		return this.visible ? [this.rect] : [];
	}
	getBoundingClientRect() {
		return this.rect;
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	matches(selector: string) {
		if (selector === "[data-sidebar-cycle-item]") return this.attributes.has("data-sidebar-cycle-item");
		assert.equal(selector, ':disabled, [aria-disabled="true"], [aria-haspopup]:not([aria-haspopup="false"])');
		return (
			this.attributes.has("disabled") ||
			this.attributes.get("aria-disabled") === "true" ||
			(this.attributes.has("aria-haspopup") && this.attributes.get("aria-haspopup") !== "false")
		);
	}
	closest(selector: string): ElementAdapter | null {
		if (selector.startsWith("input,")) return this.editable ? this : (this.parentElement?.closest(selector) ?? null);
		assert.equal(selector, '[inert], [hidden], [aria-hidden="true"]');
		return this.attributes.has("inert") ||
			this.attributes.has("hidden") ||
			this.attributes.get("aria-hidden") === "true"
			? this
			: (this.parentElement?.closest(selector) ?? null);
	}
	querySelectorAll(selector: string): ElementAdapter[] {
		assert.equal(selector, "[data-sidebar-cycle-item]");
		return this.children.flatMap((child) => [
			...(child.attributes.has("data-sidebar-cycle-item") ? [child] : []),
			...child.querySelectorAll(selector),
		]);
	}
}

function event(options: Partial<KeyboardEvent> = {}) {
	const value = new Event("keydown", { cancelable: true });
	Object.assign(value, {
		key: "]",
		ctrlKey: true,
		metaKey: false,
		altKey: true,
		shiftKey: false,
		repeat: false,
		isComposing: false,
		keyCode: 0,
		getModifierState: () => false,
		...options,
	});
	return value as KeyboardEvent;
}
function harness(bindings: AppKeybindings = DEFAULT_APP_KEYBINDINGS) {
	const doc = new DocumentAdapter();
	const root = new ElementAdapter(doc);
	const list = new ElementAdapter(doc, root);
	list.style.overflowY = "auto";
	let enabled = true;
	const owner = new SidebarItemNavigation(root as unknown as HTMLElement, bindings, () => enabled, false);
	const rows = Array.from({ length: 4 }, () => {
		const row = new ElementAdapter(doc, list);
		row.attributes.set("data-sidebar-cycle-item", "");
		return row;
	});
	return {
		doc,
		root,
		list,
		owner,
		rows,
		disable: () => {
			enabled = false;
		},
		select: (index: number) => {
			for (const row of rows) row.attributes.delete("aria-current");
			rows[index]?.attributes.set("aria-current", "page");
		},
		next: (options: Partial<KeyboardEvent> = {}) => owner.keyDown(event(options)),
		previous: () => owner.keyDown(event({ key: "[" })),
	};
}
beforeEach(() => vi.stubGlobal("Element", ElementAdapter));
afterEach(() => vi.unstubAllGlobals());

test("default primary and alternate shortcuts are platform-specific and all command labels are localized", () => {
	for (const [command, key] of [
		["previousSidebarItem", "["],
		["previousSidebarItemAlternate", "ArrowLeft"],
		["nextSidebarItem", "]"],
		["nextSidebarItemAlternate", "ArrowRight"],
	] as const) {
		assert.equal(matchesBinding(event({ key }), DEFAULT_APP_KEYBINDINGS[command], false), true);
		assert.equal(
			matchesBinding(event({ key, ctrlKey: false, metaKey: true }), DEFAULT_APP_KEYBINDINGS[command], true),
			true,
		);
		assert.equal(matchesBinding(event({ key, shiftKey: true }), DEFAULT_APP_KEYBINDINGS[command], false), false);
		assert.notEqual(appKeybindingLabels("en")[command], appKeybindingLabels("zh-CN")[command]);
	}
});
test("no active item starts at first or last and includes distinct project/chat alias rows in DOM order", () => {
	const ui = harness();
	ui.next();
	assert.equal(ui.rows[0].click.mock.calls.length, 1);
	ui.owner.reset();
	ui.previous();
	assert.equal(ui.rows[3].click.mock.calls.length, 1);
	ui.select(1);
	ui.owner.reset();
	ui.next();
	assert.equal(ui.rows[2].click.mock.calls.length, 1);
});
test("last current alias is used, and first/last boundaries do not wrap", () => {
	const ui = harness();
	ui.rows[0].attributes.set("aria-current", "page");
	ui.rows[2].attributes.set("aria-current", "page");
	ui.next();
	assert.equal(ui.rows[3].click.mock.calls.length, 1);
	ui.next({ repeat: true });
	assert.equal(ui.rows[0].click.mock.calls.length, 0);
	ui.owner.reset();
	ui.select(0);
	ui.previous();
	assert.equal(ui.rows[3].click.mock.calls.length, 1);
});
test("repeated navigation advances before React updates aria-current", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.next({ repeat: true });
	ui.next({ repeat: true });
	assert.deepEqual(
		ui.rows.map((row) => row.click.mock.calls.length),
		[0, 1, 1, 1],
	);
});
test("a current route outside the visited sequence supersedes a delayed key sequence", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.select(3);
	ui.previous();
	assert.equal(ui.rows[2].click.mock.calls.length, 1);
});
test("a repeated sequence retains its ordering while the same rendered items reorder", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.list.children = [ui.rows[3], ui.rows[1], ui.rows[0], ui.rows[2]];
	ui.next({ repeat: true });
	assert.equal(ui.rows[2].click.mock.calls.length, 1);
	assert.equal(ui.rows[0].click.mock.calls.length, 0);
});
test("changed mounted membership rebuilds the order without fetching virtual rows", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.list.children = [ui.rows[0], ui.rows[1], ui.rows[3]];
	ui.next({ repeat: true });
	assert.equal(ui.rows[3].click.mock.calls.length, 1);
	assert.equal(ui.rows[2].click.mock.calls.length, 0);
});
test("unmounting the intended item falls back to the current eligible item", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.rows[1].isConnected = false;
	ui.next({ repeat: true });
	assert.equal(ui.rows[2].click.mock.calls.length, 1);
});
for (const state of [
	"hidden",
	"inert",
	"aria-hidden",
	"disabled",
	"aria-disabled",
	"aria-haspopup",
	"invisible",
	"no-rect",
] as const) {
	test(`${state} excludes a row without changing another row's action`, () => {
		const ui = harness();
		ui.select(0);
		if (state === "invisible") ui.rows[1].style.visibility = "hidden";
		else if (state === "no-rect") ui.rows[1].visible = false;
		else ui.rows[1].attributes.set(state, state.startsWith("aria-") ? "true" : "");
		ui.next();
		assert.equal(ui.rows[1].click.mock.calls.length, 0);
		assert.equal(ui.rows[2].click.mock.calls.length, 1);
	});
}
test("modifier release resets settled selection, and keeps only needed lagging intent", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	ui.select(1);
	ui.owner.keyUp(event({ altKey: false }));
	ui.list.children = [ui.rows[0], ui.rows[1], ui.rows[3], ui.rows[2]];
	ui.next();
	assert.equal(ui.rows[3].click.mock.calls.length, 1);
	const lag = harness();
	lag.select(0);
	lag.next();
	lag.owner.keyUp(event({ altKey: false }));
	lag.next();
	assert.equal(lag.rows[2].click.mock.calls.length, 1);
});
test("pointer, blur and detach reset intent and cancel scheduled scrolling", () => {
	const ui = harness();
	const detach = ui.owner.attach();
	ui.select(0);
	ui.next();
	ui.doc.dispatchEvent(new Event("pointerdown"));
	assert.equal(ui.doc.defaultView.frames.size, 0);
	ui.next();
	assert.equal(ui.rows[1].click.mock.calls.length, 2);
	ui.doc.defaultView.dispatchEvent(new Event("blur"));
	ui.next();
	assert.equal(ui.rows[1].click.mock.calls.length, 3);
	detach();
	assert.equal(ui.doc.defaultView.frames.size, 0);
	ui.doc.defaultView.dispatchEvent(event());
	assert.equal(ui.rows[1].click.mock.calls.length, 3);
});
test("plain Enter activation resets the sequence without suppressing the native event", () => {
	const ui = harness();
	ui.select(0);
	ui.next();
	const enter = event({ key: "Enter", ctrlKey: false, altKey: false });
	Object.defineProperty(enter, "target", { value: ui.rows[0] });
	ui.owner.keyDown(enter);
	ui.next();
	assert.equal(enter.defaultPrevented, false);
	assert.equal(ui.rows[1].click.mock.calls.length, 2);
});
test("composition, AltGraph, prevented events, modal owners and disabled navigation do not activate", () => {
	const ui = harness();
	ui.next({ isComposing: true });
	ui.next({ keyCode: 229 });
	ui.next({ getModifierState: () => true });
	const prevented = event();
	prevented.preventDefault();
	ui.owner.keyDown(prevented);
	ui.doc.modal = true;
	ui.next();
	ui.doc.modal = false;
	ui.root.attributes.set("inert", "");
	ui.next();
	ui.root.attributes.delete("inert");
	ui.disable();
	ui.next();
	assert.deepEqual(
		ui.rows.map((row) => row.click.mock.calls.length),
		[0, 0, 0, 0],
	);
});
test("default shortcuts activate from an editable target without explicitly focusing; plain custom keys preserve typing", () => {
	const ui = harness();
	const input = new ElementAdapter(ui.doc);
	input.editable = true;
	const key = event();
	Object.defineProperty(key, "target", { value: input });
	ui.owner.keyDown(key);
	assert.equal(ui.rows[0].click.mock.calls.length, 1);
	assert.equal(input.focus.mock.calls.length, 0);
	assert.equal(
		ui.rows.some((row) => row.focus.mock.calls.length),
		false,
	);
	const custom = harness({ ...DEFAULT_APP_KEYBINDINGS, nextSidebarItem: "j", nextSidebarItemAlternate: "" });
	const typing = event({ key: "j", ctrlKey: false, altKey: false });
	Object.defineProperty(typing, "target", { value: input });
	custom.owner.keyDown(typing);
	assert.equal(typing.defaultPrevented, false);
	assert.equal(custom.rows[0].click.mock.calls.length, 0);
});
test("scrolling is nearest-container, scale-aware and minimal with client border and padding", () => {
	const ui = harness();
	ui.select(0);
	ui.list.rect = { top: 100, height: 400 };
	ui.list.offsetHeight = 200;
	ui.list.clientTop = 1;
	ui.list.clientHeight = 198;
	ui.list.scrollTop = 40;
	ui.list.style.scrollPaddingTop = "10px";
	ui.list.style.scrollPaddingBottom = "8px";
	ui.rows[1].rect = { top: 500, height: 60 };
	ui.next();
	ui.doc.defaultView.flush();
	assert.deepEqual(ui.list.scrollTo.mock.calls, [[{ top: 79, behavior: "instant" }]]);
	assert.equal(ui.root.scrollTo.mock.calls.length, 0);
	assert.equal(ui.rows[1].focus.mock.calls.length, 0);
});
test("a removed or newly hidden destination never receives a stale scroll", () => {
	const ui = harness();
	ui.next();
	ui.rows[0].isConnected = false;
	ui.doc.defaultView.flush();
	assert.equal(ui.list.scrollTo.mock.calls.length, 0);
	ui.owner.reset();
	ui.next();
	ui.list.attributes.set("hidden", "");
	ui.doc.defaultView.flush();
	assert.equal(ui.list.scrollTo.mock.calls.length, 0);
});
