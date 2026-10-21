// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { act, type ReactNode, StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { formatBinding } from "../../../src/app/keybindings.ts";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import {
	ActionMenu,
	ActionMenuContent,
	ActionMenuItem,
	ActionMenuTrigger,
} from "../../../src/components/ui/action-menu.tsx";
import { ActionTooltip, ActionTooltipProvider } from "../../../src/components/ui/action-tooltip.tsx";
import { SidebarActionTooltip } from "../../../src/features/workbench/sidebar/action-tooltip.tsx";
import {
	SidebarDragProvider,
	type SidebarOrderAction,
} from "../../../src/features/workbench/sidebar/drag-provider.tsx";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";
import { SidebarPreviewRow } from "../../../src/features/workbench/sidebar/preview-row.tsx";

// Real React, Radix portals and DOM events. jsdom does not establish layout or native focus geometry.
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const render = async (children: ReactNode) => {
	await act(async () => root.render(<StrictMode>{children}</StrictMode>));
};
const tick = async (ms: number) => {
	await act(async () => vi.advanceTimersByTimeAsync(ms));
};
function button(name: string) {
	const node = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
	assert.ok(node, name);
	return node;
}
async function pointer(node: HTMLElement, type: string, relatedTarget: EventTarget | null = null) {
	await act(async () => {
		node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget }));
	});
}
// jsdom has no native focus-visible modality policy. Supply keyboard intent only
// for this selector while retaining actual DOM focus and React/Radix handlers.
async function keyboardFocus(target: HTMLElement) {
	const matches = target.matches.bind(target);
	const selector = vi
		.spyOn(target, "matches")
		.mockImplementation((value) => value === ":focus-visible" || matches(value));
	try {
		await act(async () => target.focus());
	} finally {
		selector.mockRestore();
	}
}

const tooltip = () => document.querySelector('[role="tooltip"]');

test("real Radix delay, warm peer transfer, focus and Escape preserve trigger nodes", async () => {
	await render(
		<ActionTooltipProvider>
			<ActionTooltip label="Search">
				<button aria-label="Search" type="button">
					S
				</button>
			</ActionTooltip>
			<ActionTooltip label="Collapse">
				<button aria-label="Collapse" type="button">
					C
				</button>
			</ActionTooltip>
		</ActionTooltipProvider>,
	);
	const search = button("Search");
	const collapse = button("Collapse");
	await pointer(search, "pointermove");
	await tick(199);
	assert.equal(Boolean(tooltip()), false);
	await tick(1);
	assert.equal(tooltip()?.textContent, "Search");
	assert.ok(search.getAttribute("aria-describedby"));
	assert.equal(search.getAttribute("title"), null);
	await pointer(search, "pointerout", collapse);
	await pointer(collapse, "pointermove", search);
	assert.equal(tooltip()?.textContent, "Collapse");
	assert.equal(document.querySelectorAll('[role="tooltip"]').length, 1);
	await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	assert.equal(Boolean(tooltip()), false);
	await keyboardFocus(search);
	assert.equal(tooltip()?.textContent, "Search");
	assert.equal(button("Search"), search);
	assert.equal(button("Collapse"), collapse);
});

test("disabled scope retires a mounted tooltip without replacing its button or reopening on enable", async () => {
	const view = (disabled: boolean) => (
		<ActionTooltipProvider disabled={disabled}>
			<ActionTooltip label="搜索聊天">
				<button type="button" aria-label="搜索聊天">
					S
				</button>
			</ActionTooltip>
		</ActionTooltipProvider>
	);
	await render(view(false));
	const target = button("搜索聊天");
	await keyboardFocus(target);
	assert.equal(tooltip()?.textContent, "搜索聊天");
	await render(view(true));
	assert.equal(Boolean(tooltip()), false);
	assert.equal(button("搜索聊天"), target);
	assert.equal(document.activeElement, target);
	await render(view(false));
	assert.equal(Boolean(tooltip()), false);
	await pointer(target, "pointerout");
	await pointer(target, "pointermove");
	await tick(200);
	assert.equal(tooltip()?.textContent, "搜索聊天");
});

test("disabled scope invalidates pending opens, including motion before the old deadline", async () => {
	const view = (disabled: boolean) => (
		<ActionTooltipProvider disabled={disabled}>
			<ActionTooltip label="Pending">
				<button type="button" aria-label="Pending">
					P
				</button>
			</ActionTooltip>
		</ActionTooltipProvider>
	);
	await render(view(false));
	const target = button("Pending");
	await pointer(target, "pointermove");
	await tick(100);
	await render(view(true));
	await render(view(false));
	await pointer(target, "pointermove");
	await tick(100);
	assert.equal(Boolean(tooltip()), false);
	assert.equal(button("Pending"), target);
	await pointer(target, "pointerout");
	await pointer(target, "pointermove");
	await tick(199);
	assert.equal(Boolean(tooltip()), false);
	await tick(1);
	assert.equal(tooltip()?.textContent, "Pending");
});

test("canceling pending hover preserves the peer cold budget and row ownership", async () => {
	let leaves = 0;
	let clicks = 0;
	const view = (disabled: boolean, visible = true) => (
		<ActionTooltipProvider>
			<div
				onPointerLeave={() => {
					leaves++;
				}}
			>
				{visible ? (
					<ActionTooltip disabled={disabled} label="Pending">
						<button
							type="button"
							aria-label="Pending"
							onClick={() => {
								clicks++;
							}}
						>
							P
						</button>
					</ActionTooltip>
				) : null}
				<ActionTooltip label="Peer">
					<button type="button" aria-label="Peer">
						N
					</button>
				</ActionTooltip>
			</div>
		</ActionTooltipProvider>
	);
	await render(view(false));
	const target = button("Pending");
	const peer = button("Peer");
	const focus = document.activeElement;
	await pointer(target, "pointermove");
	await tick(100);
	await render(view(true));
	await render(view(false));
	await tick(100);
	assert.equal(Boolean(tooltip()), false);
	assert.equal(button("Pending"), target);
	assert.equal(document.activeElement, focus);
	assert.equal(leaves, 0);
	assert.equal(clicks, 0);
	await pointer(peer, "pointermove");
	await tick(199);
	assert.equal(Boolean(tooltip()), false);
	await tick(1);
	assert.equal(tooltip()?.textContent, "Peer");
	await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	await keyboardFocus(target);
	assert.equal(tooltip()?.textContent, "Pending");
	await render(view(true));
	assert.equal(document.activeElement, target);
	assert.equal(Boolean(tooltip()), false);
	await render(view(false));
	await keyboardFocus(peer);
	await keyboardFocus(target);
	assert.equal(tooltip()?.textContent, "Pending");
	await act(async () => target.blur());
	await tick(300);
	await pointer(target, "pointermove");
	await tick(100);
	await render(view(false, false));
	await tick(100);
	assert.equal(Boolean(tooltip()), false);
	await pointer(peer, "pointerout");
	await pointer(peer, "pointermove");
	await tick(199);
	assert.equal(Boolean(tooltip()), false);
	await tick(1);
	assert.equal(tooltip()?.textContent, "Peer");
});

function NavigationHandoffFixture() {
	const [collapsed, setCollapsed] = useState(false);
	const collapse = useRef<HTMLButtonElement>(null);
	const expand = useRef<HTMLButtonElement>(null);
	const restore = useRef(false);
	useLayoutEffect(() => {
		if (!restore.current) return;
		(collapsed ? expand : collapse).current?.focus({ preventScroll: true });
		restore.current = false;
	}, [collapsed]);
	return (
		<ActionTooltipProvider>
			<ActionTooltip label="Collapse navigation" disabled={collapsed}>
				<button
					type="button"
					hidden={collapsed}
					ref={collapse}
					aria-label="Collapse navigation"
					onClick={() => {
						restore.current = true;
						setCollapsed(true);
					}}
				>
					C
				</button>
			</ActionTooltip>
			<ActionTooltip label="Toggle navigation" disabled={!collapsed}>
				<button
					type="button"
					hidden={!collapsed}
					ref={expand}
					aria-label="Toggle navigation"
					onClick={() => {
						restore.current = true;
						setCollapsed(false);
					}}
				>
					E
				</button>
			</ActionTooltip>
		</ActionTooltipProvider>
	);
}

test.each(["pointer", "keyboard"] as const)(
	"%s focus handoff preserves navigation focus without inventing hover",
	async (origin) => {
		await render(<NavigationHandoffFixture />);
		const collapse = button("Collapse navigation");
		const expand = button("Toggle navigation");
		// jsdom does not implement browser input-modality heuristics. Model only that
		// browser-owned selector; React, Radix, layout effects, events and focus remain real.
		for (const target of [collapse, expand]) {
			const matches = target.matches.bind(target);
			vi.spyOn(target, "matches").mockImplementation((selector) =>
				selector === ":focus-visible" ? origin === "keyboard" && document.activeElement === target : matches(selector),
			);
		}
		if (origin === "pointer") {
			await pointer(collapse, "pointermove");
			await tick(200);
		} else {
			await act(async () => {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
				collapse.focus();
			});
		}
		assert.equal(tooltip()?.textContent, "Collapse navigation");
		for (const [source, target] of [
			[collapse, expand],
			[expand, collapse],
			[collapse, expand],
			[expand, collapse],
		] as const) {
			const focused = vi.spyOn(target, "focus");
			await act(async () => {
				if (origin === "pointer") {
					source.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, button: 0 }));
					source.focus();
					source.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true, button: 0 }));
				} else source.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				// jsdom does not perform native pointer/Enter click synthesis.
				source.click();
			});
			assert.equal(document.activeElement, target, "Restoration must retain the newly visible button");
			assert.deepEqual(focused.mock.calls, [[{ preventScroll: true }]]);
			focused.mockRestore();
			assert.equal(button("Collapse navigation"), collapse);
			assert.equal(button("Toggle navigation"), expand);
			if (origin === "pointer")
				assert.equal(Boolean(tooltip()), false, "Pointer-initiated restoration is not keyboard intent");
			else assert.equal(tooltip()?.textContent, target.getAttribute("aria-label"));
		}
		if (origin === "pointer") {
			await pointer(document.body, "pointermove");
			await tick(500);
			assert.equal(Boolean(tooltip()), false, "Pointer away from both targets must not show a handoff hint");
			await pointer(collapse, "pointermove");
			await tick(200);
			assert.equal(tooltip()?.textContent, "Collapse navigation", "Fresh deliberate hover remains available");
		}
	},
);

test("desktop focus restoration wiring requests viewport preservation in both directions", async () => {
	// Wiring coverage only; the mounted fixture verifies actual focus/options, not
	// browser layout or automatic scrolling. Native regression owns that evidence.
	const source = await readFile(new NodeURL("../../../src/features/workbench/workbench.tsx", import.meta.url), "utf8");
	assert.match(
		source,
		/navigationFocus.current === "header" && navigationCollapsed\)\s*navigationToggle.current\?\.focus\(\{ preventScroll: true \}\)/,
	);
	assert.match(
		source,
		/navigationFocus.current === "sidebar" && !navigationCollapsed\)\s*sidebarCollapse.current\?\.focus\(\{ preventScroll: true \}\)/,
	);
});

test("mixed pointer and keyboard restoration retains focus while deliberate ancestor scrolling dismisses hints", async () => {
	await render(<NavigationHandoffFixture />);
	const collapse = button("Collapse navigation");
	const expand = button("Toggle navigation");
	let keyboard = false;
	for (const target of [collapse, expand]) {
		const matches = target.matches.bind(target);
		vi.spyOn(target, "matches").mockImplementation((selector) =>
			selector === ":focus-visible" ? keyboard && document.activeElement === target : matches(selector),
		);
	}
	await act(async () => {
		collapse.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
		collapse.focus();
		collapse.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
		collapse.click();
	});
	assert.equal(document.activeElement, expand);
	assert.equal(Boolean(tooltip()), false);
	keyboard = true;
	await act(async () => {
		expand.blur();
		expand.focus();
	});
	assert.equal(tooltip()?.textContent, "Toggle navigation");
	await act(async () => expand.click());
	assert.equal(document.activeElement, collapse);
	assert.equal(tooltip()?.textContent, "Collapse navigation");
	// Explicit ancestor scrolling must still dismiss through Radix. Do not reopen
	// a hint merely because the restored control remains keyboard-focused.
	await act(async () => host.dispatchEvent(new Event("scroll")));
	assert.equal(document.activeElement, collapse);
	assert.equal(Boolean(tooltip()), false);
	await tick(500);
	assert.equal(Boolean(tooltip()), false);
});

function RowFixture({
	disabled = false,
	iconDisabled = false,
	orderAction,
}: {
	disabled?: boolean;
	iconDisabled?: boolean;
	orderAction?: SidebarOrderAction;
}) {
	return (
		<ActionTooltipProvider>
			<SidebarPreviewProvider disabled={disabled} navigationKey="test">
				<SidebarPreviewRow
					orderAction={orderAction}
					className="project-row"
					selected={false}
					titleId="project-name"
					preview={() => <span>Project preview</span>}
					renderActions={(controls) => (
						<ActionMenu boundary={controls.rowMenu}>
							<div className="sidebar-row-actions">
								<SidebarActionTooltip label="Project actions" disabled={iconDisabled}>
									<ActionMenuTrigger asChild>
										<button type="button" ref={controls.triggerRef} aria-label="Project actions">
											…
										</button>
									</ActionMenuTrigger>
								</SidebarActionTooltip>
							</div>
							<ActionMenuContent>
								<ActionMenuItem>Rename</ActionMenuItem>
							</ActionMenuContent>
						</ActionMenu>
					)}
				>
					<button type="button" className="project-open" id="project-name" aria-label="Project">
						Project
					</button>
				</SidebarPreviewRow>
			</SidebarPreviewProvider>
		</ActionTooltipProvider>
	);
}

test("mounted row icon hover excludes preview; menu ownership closes tooltip and preserves source", async () => {
	await render(<RowFixture />);
	const label = button("Project");
	const menu = button("Project actions");
	await pointer(label, "pointerover");
	await pointer(label, "pointermove");
	await tick(200);
	assert.ok(document.querySelector(".conversation-preview-card"));
	await pointer(menu, "pointermove");
	await tick(200);
	assert.equal(document.querySelector(".conversation-preview-card"), null);
	assert.equal(tooltip()?.textContent, "Project actions");
	await act(async () =>
		menu.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0, ctrlKey: false }),
		),
	);
	assert.ok(document.querySelector('[role="menu"]'));
	assert.equal(Boolean(tooltip()), false);
	assert.equal(button("Project actions"), menu);
	await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	await tick(1);
	assert.equal(Boolean(tooltip()), false, "Menu return focus must not re-open its hint");
	await render(<RowFixture disabled />);
	assert.equal(document.querySelector('[role="menu"]'), null);
	assert.equal(Boolean(tooltip()), false);
	await pointer(menu, "pointermove");
	await tick(500);
	assert.equal(Boolean(tooltip()), false);
	assert.equal(document.querySelector(".conversation-preview-card"), null);
});

test.each(["ellipsis", "context"] as const)(
	"%s menu retains child state and the open rail CSS predicate after pointer departure",
	async (entry) => {
		const sidebarCss = await readFile(
			new NodeURL("../../../src/features/workbench/sidebar/layout.css", import.meta.url),
			"utf8",
		);
		await render(<RowFixture />);
		const label = button("Project");
		const trigger = button("Project actions");
		const row = trigger.closest<HTMLElement>(".sidebar-preview-row");
		const rail = trigger.closest<HTMLElement>(".sidebar-row-actions");
		assert.ok(row && rail);
		await pointer(trigger, "pointermove");
		await tick(200);
		assert.equal(tooltip()?.textContent, "Project actions");
		assert.equal(trigger.getAttribute("data-state"), "closed", "Tooltip open state must not replace menu closed state");
		if (entry === "ellipsis")
			await act(async () =>
				trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })),
			);
		else
			await act(async () =>
				label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 20, clientY: 20 })),
			);
		await pointer(trigger, "pointerout", document.body);
		await tick(300);
		const menu = document.querySelector<HTMLElement>('[role="menu"]');
		assert.ok(menu);
		assert.equal(
			menu.getAttribute("data-slot"),
			entry === "ellipsis" ? "dropdown-menu-content" : "context-menu-content",
		);
		assert.equal(trigger.getAttribute("data-slot"), "dropdown-menu-trigger");
		assert.equal(trigger.getAttribute("data-state"), entry === "ellipsis" ? "open" : "closed");
		assert.equal(trigger.getAttribute("aria-expanded"), entry === "ellipsis" ? "true" : "false");
		const rowSelector =
			entry === "ellipsis"
				? '.sidebar-preview-row:has([data-state="open"])'
				: '.sidebar-preview-row[data-state="open"]';
		const railSelector =
			entry === "ellipsis"
				? '.sidebar-row-actions:has([aria-haspopup="menu"][aria-expanded="true"])'
				: '.sidebar-preview-row[data-state="open"] .sidebar-row-actions';
		assert.ok(sidebarCss.includes(rowSelector));
		assert.ok(sidebarCss.includes(railSelector));
		assert.equal(row.matches(rowSelector), true, "Open menu retains the production background selector without hover");
		assert.equal(
			rail.matches(railSelector),
			true,
			"Open menu retains the production action rail selector without hover",
		);
		assert.equal(menu.contains(document.activeElement), true);
		assert.equal(button("Project actions"), trigger);
		assert.equal(trigger.parentElement, rail, "No wrapper DOM is added around the actual trigger");
		assert.equal(Boolean(tooltip()), false);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await tick(1);
		assert.equal(Boolean(document.querySelector('[role="menu"]')), false);
		assert.equal(trigger.getAttribute("data-state"), "closed");
		assert.equal(row.matches(rowSelector), false);
		assert.equal(rail.matches(railSelector), false);
		if (entry === "ellipsis")
			assert.equal(document.activeElement, trigger, "Dropdown returns focus through the composed trigger ref");
		assert.equal(button("Project actions"), trigger);
	},
);

test("canceling one icon leaves an unrelated mounted row preview intact", async () => {
	await render(<RowFixture />);
	const label = button("Project");
	const menu = button("Project actions");
	await pointer(label, "pointerover");
	await pointer(label, "pointermove");
	await tick(200);
	const card = document.querySelector(".conversation-preview-card");
	assert.ok(card);
	await render(<RowFixture iconDisabled />);
	assert.equal(document.querySelector(".conversation-preview-card"), card);
	assert.equal(button("Project"), label);
	assert.equal(button("Project actions"), menu);
	assert.equal(Boolean(document.querySelector('[role="menu"]')), false);
	assert.equal(Boolean(document.querySelector('[data-sidebar-dragging="true"]')), false);
});

const orderAction: SidebarOrderAction = {
	item: {
		id: "project",
		group: "projects",
		label: "Project",
		revision: "one",
		disabled: false,
		after: null,
		move: () => {},
	},
	up: undefined,
	down: undefined,
};
function DragFixture() {
	const scroll = useRef<HTMLDivElement>(null);
	return (
		<PreferencesProvider>
			<div ref={scroll}>
				<SidebarDragProvider scrollRef={scroll}>
					<RowFixture orderAction={orderAction} />
				</SidebarDragProvider>
			</div>
		</PreferencesProvider>
	);
}
test("real dnd-kit pointer activation fences tooltips and preserves its exact source node", async () => {
	await render(<DragFixture />);
	const label = button("Project");
	const menu = button("Project actions");
	await keyboardFocus(menu);
	assert.ok(tooltip());
	await act(async () =>
		label.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				isPrimary: true,
				pointerId: 1,
				pointerType: "mouse",
				button: 0,
				buttons: 1,
				clientX: 20,
				clientY: 20,
			}),
		),
	);
	await act(async () =>
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 1,
				pointerType: "mouse",
				buttons: 1,
				clientX: 40,
				clientY: 40,
			}),
		),
	);
	assert.ok(document.querySelector('[data-sidebar-dragging="true"]'));
	assert.equal(Boolean(tooltip()), false);
	await pointer(menu, "pointermove");
	await tick(400);
	assert.equal(Boolean(tooltip()), false);
	assert.equal(button("Project"), label);
	await act(async () => document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
	assert.ok(document.querySelector('[data-sidebar-dragging="false"]'));
});
test("shortcut display reflects only configured commands and platform modifiers", () => {
	assert.equal(formatBinding("", true), "");
	assert.equal(formatBinding("Mod-Shift-k", true), "⌘⇧K");
	assert.equal(formatBinding("Mod-Shift-k", false), "Ctrl+Shift+K");
});
