import assert from "node:assert/strict";
import { AnimatePresence, motion } from "framer-motion";
import { type ComponentProps, type ElementType, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS } from "../../../src/app/keybindings.ts";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { defaultConfig, type ThemeConfig } from "../../../src/app/theme/index.ts";
import { themeStorageKey } from "../../../src/app/theme/store.ts";
import {
	SidebarDragProvider,
	type SidebarOrderAction,
} from "../../../src/features/workbench/sidebar/drag-provider.tsx";
import {
	SidebarOrderSection,
	SidebarSectionContent,
	SidebarSectionHeading,
	useSidebarSection,
} from "../../../src/features/workbench/sidebar/section.tsx";

// Real React, dnd-kit and Motion SSR composition. The probes additionally expose
// the production element callbacks/animation props during a real React render.
// This does not simulate browser key-to-click synthesis, focus, geometry or an
// AnimatePresence exit lifecycle; those require mounted/native evidence.
function elements<C extends ElementType>(node: ReactNode, type: C): ReactElement<ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<ComponentProps<C>>(node) ? [node, ...children] : children;
}
function element<C extends ElementType>(node: ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	const only = found[0];
	assert.ok(only);
	return only;
}
function invoke(callback: unknown, ...args: unknown[]) {
	assert.equal(typeof callback, "function");
	return Reflect.apply(callback as (...args: unknown[]) => unknown, undefined, args);
}
function keyboard(key: string, altKey = false) {
	return {
		key,
		altKey,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		repeat: false,
		defaultPrevented: false,
		nativeEvent: { isComposing: false },
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	};
}

afterEach(() => vi.unstubAllGlobals());

function harness({
	collapsed,
	disabled = false,
	itemDisabled = false,
	reducedMotion = "system",
	locale = "en",
	actions,
	keybindings = DEFAULT_APP_KEYBINDINGS,
}: {
	collapsed?: boolean;
	disabled?: boolean;
	itemDisabled?: boolean;
	reducedMotion?: ThemeConfig["reducedMotion"];
	locale?: ThemeConfig["locale"];
	actions?: ReactNode;
	keybindings?: AppKeybindings;
} = {}) {
	// Only preference storage and an event host are adapted. Library modules and
	// React hooks remain real, with no document/browser geometry in this harness.
	vi.stubGlobal(
		"window",
		Object.assign(new EventTarget(), {
			localStorage: {
				getItem: (key: string) =>
					key === themeStorageKey ? JSON.stringify({ ...defaultConfig(), locale, reducedMotion }) : null,
			},
		}),
	);
	const move = vi.fn();
	const change = vi.fn();
	const action: SidebarOrderAction = {
		item: {
			id: "projects",
			group: "sections",
			label: "Projects",
			revision: "1",
			disabled: itemDisabled,
			after: "recent",
			move,
		},
		up: "pinned",
		down: null,
	};
	const captured: {
		heading?: ReactNode;
		content?: ReactNode;
		section: ReturnType<typeof useSidebarSection>;
	} = { section: null };
	function HeadingProbe() {
		captured.section = useSidebarSection();
		captured.heading = SidebarSectionHeading({ children: "Projects", actions });
		return captured.heading;
	}
	function ContentProbe() {
		captured.content = SidebarSectionContent({ children: <button type="button">Visible project</button> });
		return captured.content;
	}
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<SidebarDragProvider scrollRef={{ current: null }} keybindings={keybindings}>
				<SidebarOrderSection action={action} collapsed={collapsed} disabled={disabled} onCollapsedChange={change}>
					<HeadingProbe />
					<ContentProbe />
				</SidebarOrderSection>
			</SidebarDragProvider>
		</PreferencesProvider>,
	);
	assert.ok(captured.section);
	return { html, heading: captured.heading, content: captured.content, section: captured.section, move, change };
}

test("default expanded sections use one native text-and-chevron heading, not a separate grip", () => {
	const ui = harness();
	const heading = element(ui.heading, "button");
	assert.equal(heading.props.type, "button");
	assert.equal(heading.props["aria-expanded"], true);
	assert.equal(heading.props["aria-label"], undefined, "visible text supplies the accessible name");
	assert.equal(heading.props["aria-pressed"], undefined);
	assert.equal(heading.props.role, undefined);
	assert.equal(heading.props.disabled, undefined);
	assert.equal(elements(heading.props.children, "button").length, 0);
	assert.match(ui.html, /<h3><button[^>]*><span>Projects<\/span><span class="sidebar-section-chevron"/);
	assert.match(ui.html, /data-expanded="true"/);
	assert.match(ui.html, /<svg aria-hidden="true"/);
	assert.doesNotMatch(ui.html, /sidebar-section-grip|Move up|Move down|aria-pressed=/);
	assert.equal((ui.html.match(/<button\b/g) ?? []).length, 2);
	assert.match(ui.html, /Visible project/);
	assert.doesNotMatch(ui.html, /inert=|class="sidebar-section-content"[^>]*aria-hidden=/);
	assert.equal(ui.move.mock.calls.length, 0);
	assert.equal(ui.change.mock.calls.length, 0);
});

test("heading, content and dnd-kit descriptions have distinct correctly associated IDs", () => {
	const ui = harness();
	const heading = element(ui.heading, "button");
	const content = element(ui.content, "section");
	assert.equal(heading.props.id, ui.section.headingId);
	assert.equal(heading.props["aria-controls"], content.props.id);
	assert.equal(content.props["aria-labelledby"], heading.props.id);
	assert.notEqual(content.props.id, heading.props.id);
	assert.match(heading.props["aria-describedby"] ?? "", /^DndDescribedBy-/);
	assert.equal(heading.props["aria-describedby"], ui.section.sortable.describedBy);
	assert.equal(heading.props.onPointerDown, ui.section.sortable.onPointerDown);
	assert.equal(heading.props.onKeyDown, ui.section.sortable.onKeyDown);
	assert.match(ui.html, /aria-controls="[^"]+"/);
	assert.match(ui.html, /aria-labelledby="[^"]+"/);
});

test("a sibling heading action never becomes a nested disclosure or drag activator", () => {
	const action = vi.fn();
	const ui = harness({
		actions: (
			<button type="button" onClick={action}>
				New project
			</button>
		),
	});
	const headings = element(ui.heading, "h3");
	assert.equal(elements(headings, "button").length, 1);
	const buttons = elements(ui.heading, "button");
	assert.equal(buttons.length, 2);
	const sibling = buttons.find((button) => button.props.children === "New project");
	assert.ok(sibling);
	assert.equal(sibling.props.onPointerDown, undefined);
	assert.equal(sibling.props.onKeyDown, undefined);
	assert.equal(sibling.props["aria-expanded"], undefined);
	invoke(sibling.props.onClick);
	assert.equal(action.mock.calls.length, 1);
	assert.equal(ui.change.mock.calls.length, 0);
	assert.equal(ui.move.mock.calls.length, 0);
	assert.match(ui.html, /<\/button><\/h3><button type="button">New project<\/button>/);
});

test("an initially collapsed section is immediately inert and hidden with no mounted body", () => {
	const ui = harness({ collapsed: true });
	const heading = element(ui.heading, "button");
	const content = element(ui.content, "section");
	assert.equal(heading.props["aria-expanded"], false);
	assert.equal(heading.props.title, "Expand Projects");
	assert.equal(content.props.inert, true);
	assert.equal(content.props["aria-hidden"], true);
	assert.equal(elements(ui.content, motion.div).length, 0);
	assert.equal(element(ui.content, AnimatePresence).props.children, false);
	assert.match(ui.html, /class="sidebar-section-content"[^>]*aria-hidden="true"[^>]*inert=""/);
	assert.match(ui.html, /data-expanded="false"/);
	assert.doesNotMatch(ui.html, /Visible project/);
	assert.equal((ui.html.match(/<button\b/g) ?? []).length, 1);
	invoke(heading.props.onClick);
	assert.deepEqual(ui.change.mock.calls, [[false]]);
	assert.equal(ui.move.mock.calls.length, 0);
});

test("collapse is a controlled click command, separate from keyboard ordering", () => {
	const ui = harness();
	invoke(element(ui.heading, "button").props.onClick);
	assert.deepEqual(ui.change.mock.calls, [[true]]);
	assert.equal(ui.move.mock.calls.length, 0);
	assert.equal(ui.section.collapsed, false, "the owner, not the heading callback, changes disclosure state");
	const collapsed = harness({ collapsed: true });
	assert.equal(element(collapsed.content, "section").props.inert, true);
	assert.equal(element(collapsed.content, "section").props["aria-hidden"], true);
});

for (const key of ["Enter", " "]) {
	test(`native ${JSON.stringify(key)} is not consumed or synthesized into drag/collapse by keydown`, () => {
		const ui = harness();
		const event = keyboard(key);
		invoke(element(ui.heading, "button").props.onKeyDown, event);
		assert.equal(event.preventDefault.mock.calls.length, 0);
		assert.equal(event.stopPropagation.mock.calls.length, 0);
		assert.equal(ui.change.mock.calls.length, 0);
		assert.equal(ui.move.mock.calls.length, 0);
		invoke(element(ui.heading, "button").props.onClick);
		assert.deepEqual(ui.change.mock.calls, [[true]], "native click has sole disclosure ownership");
	});
}

test("Alt-arrow heading callbacks reach the real sortable command without toggling disclosure", () => {
	const ui = harness();
	const heading = element(ui.heading, "button");
	for (const key of ["ArrowUp", "ArrowDown"]) {
		const event = keyboard(key, true);
		invoke(heading.props.onKeyDown, event);
		assert.equal(event.preventDefault.mock.calls.length, 1);
		assert.equal(event.stopPropagation.mock.calls.length, 1);
	}
	assert.deepEqual(ui.move.mock.calls, [["pinned"], [null]]);
	assert.equal(ui.change.mock.calls.length, 0);
});

test("disabled disclosure remains focusable without also disabling independent ordering", () => {
	const ui = harness({ disabled: true });
	const heading = element(ui.heading, "button");
	assert.equal(heading.props["aria-disabled"], true);
	assert.equal(heading.props.disabled, undefined);
	invoke(heading.props.onClick);
	invoke(heading.props.onKeyDown, keyboard("ArrowDown", true));
	assert.equal(ui.change.mock.calls.length, 0);
	assert.deepEqual(ui.move.mock.calls, [[null]]);
});

test("disabled ordering does not prevent an independently available disclosure", () => {
	const ui = harness({ itemDisabled: true });
	const heading = element(ui.heading, "button");
	invoke(heading.props.onClick);
	invoke(heading.props.onKeyDown, keyboard("ArrowDown", true));
	assert.deepEqual(ui.change.mock.calls, [[true]]);
	assert.equal(ui.move.mock.calls.length, 0);
});

for (const locale of ["en", "zh-CN"] as const) {
	test(`${locale} disclosure labels track state without replacing the heading text`, () => {
		const open = harness({ locale });
		const closed = harness({ locale, collapsed: true });
		assert.equal(element(open.heading, "button").props.title, locale === "en" ? "Collapse Projects" : "收起Projects");
		assert.equal(element(closed.heading, "button").props.title, locale === "en" ? "Expand Projects" : "展开Projects");
		assert.match(open.html, /<span>Projects<\/span>/);
		assert.match(closed.html, /<span>Projects<\/span>/);
	});
}

for (const reducedMotion of ["on", "off", "system"] as const) {
	test(`${reducedMotion} motion settings compose with real AnimatePresence and explicit collapse targets`, () => {
		const ui = harness({ reducedMotion });
		const content = element(ui.content, motion.div);
		assert.equal(element(ui.content, AnimatePresence).props.initial, false);
		assert.deepEqual(content.props.initial, { height: 0, opacity: 0 });
		assert.deepEqual(content.props.animate, {
			height: "auto",
			opacity: 1,
			transitionEnd: { overflow: "visible" },
		});
		assert.deepEqual(content.props.exit, { height: 0, opacity: 0, overflow: "hidden" });
		assert.deepEqual(
			content.props.transition,
			reducedMotion === "on" ? { duration: 0 } : { duration: 0.3, ease: [0.19, 1, 0.22, 1] },
			"system uses the library's unknown SSR media preference; device media changes need browser evidence",
		);
		assert.doesNotMatch(ui.html, /height:0|opacity:0/, "initial render must not flash collapsed/transparent content");
		assert.match(ui.html, /height:auto;opacity:1/);
	});
}
