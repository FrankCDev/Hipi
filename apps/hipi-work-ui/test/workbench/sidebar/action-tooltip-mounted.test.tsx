// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type ReactNode, StrictMode, useRef } from "react";
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
	await act(async () => search.focus());
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
	await act(async () => target.focus());
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
	await act(async () => target.focus());
	assert.equal(tooltip()?.textContent, "Pending");
	await render(view(true));
	assert.equal(document.activeElement, target);
	assert.equal(Boolean(tooltip()), false);
	await render(view(false));
	await act(async () => peer.focus());
	await act(async () => target.focus());
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
							<SidebarActionTooltip label="Project actions" disabled={iconDisabled}>
								<ActionMenuTrigger asChild>
									<button type="button" ref={controls.triggerRef} aria-label="Project actions">
										…
									</button>
								</ActionMenuTrigger>
							</SidebarActionTooltip>
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
	await act(async () => menu.focus());
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
