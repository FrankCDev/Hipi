// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createRef, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../../src/app/theme/index.ts";
import {
	SidebarNavigationSurface,
	SidebarSurface,
	sidebarSurfaceMotion,
	sidebarSurfaceProgress,
} from "../../../src/features/workbench/sidebar/surface.tsx";

let root: Root;
let host: HTMLDivElement;
let reduced = false;
let media: EventTarget;
const sidebar = createRef<HTMLElement>();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	reduced = false;
	media = new EventTarget();
	vi.stubGlobal("matchMedia", () => ({
		get matches() {
			return reduced;
		},
		addEventListener: media.addEventListener.bind(media),
		removeEventListener: media.removeEventListener.bind(media),
	}));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
async function render(children: ReactNode) {
	await act(async () => root.render(<StrictMode>{children}</StrictMode>));
}
async function frame(ms = 40) {
	await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}
function progress() {
	return sidebar.current?.parentElement?.style.getPropertyValue("--sidebar-progress");
}
function view(collapsed: boolean, narrow = false, reducedMotion: "on" | "off" | "system" = "on") {
	return (
		<SidebarSurface
			ref={sidebar}
			id="navigation"
			label="Projects"
			collapsed={collapsed}
			narrow={narrow}
			inert={collapsed && !narrow}
			reducedMotion={reducedMotion}
		>
			<input defaultValue="Draft" />
			<button type="button">Project</button>
		</SidebarSurface>
	);
}
test("shared scalar clamps spring overshoot and uses the desktop transition specification", () => {
	assert.deepEqual(sidebarSurfaceMotion, { type: "spring", duration: 0.3, bounce: 0.1 });
	assert.deepEqual([-0.1, 0, 0.4, 1, 1.1].map(sidebarSurfaceProgress), [0, 0, 0.4, 1, 1]);
});
test("collapse immediately gates input while preserving mounted nodes, local values and scroll state", async () => {
	await render(view(false));
	const node = sidebar.current;
	assert.ok(node);
	const input = node.querySelector("input");
	assert.ok(input);
	input.value = "Unsaved edit";
	node.scrollTop = 140;
	await render(view(true));
	assert.equal(sidebar.current, node);
	assert.equal(node.hasAttribute("inert"), true);
	assert.equal(node.getAttribute("aria-hidden"), "true");
	await frame();
	assert.equal(progress(), "0");
	assert.equal(input.value, "Unsaved edit");
	assert.equal(node.scrollTop, 140);
	await render(view(false));
	await frame();
	assert.equal(sidebar.current, node);
	assert.equal(node.hasAttribute("inert"), false);
	assert.equal(node.hasAttribute("aria-hidden"), false);
	assert.equal(progress(), "1");
	assert.equal(node.querySelector("input"), input);
});
test("interrupted real motion and narrow-mode transitions preserve the same navigation subtree", async () => {
	await render(view(false, false, "off"));
	const node = sidebar.current;
	assert.ok(node);
	await render(view(true, false, "off"));
	assert.equal(node.hasAttribute("inert"), true);
	await frame(60);
	await render(view(false, false, "off"));
	await frame(450);
	assert.equal(progress(), "1");
	await render(view(true, true, "off"));
	await frame();
	assert.equal(progress(), "1");
	assert.equal(sidebar.current, node);
	assert.equal(node.hasAttribute("inert"), false);
});
test("system reduced-motion changes stop an active spring without remounting", async () => {
	await render(view(false, false, "system"));
	const node = sidebar.current;
	assert.ok(node);
	await render(view(true, false, "system"));
	await frame();
	reduced = true;
	await act(async () => {
		media.dispatchEvent(new Event("change"));
	});
	await frame();
	assert.equal(progress(), "0");
	assert.equal(sidebar.current, node);
	await render(view(false, false, "system"));
	await frame();
	assert.equal(progress(), "1");
});

test("connected navigation surface consumes the real theme provider", async () => {
	reduced = true;
	const connected = (collapsed: boolean) => (
		<ThemeProvider>
			<SidebarNavigationSurface
				ref={sidebar}
				id="navigation"
				label="Projects"
				collapsed={collapsed}
				narrow={false}
				inert={collapsed}
			>
				<input defaultValue="Draft" />
			</SidebarNavigationSurface>
		</ThemeProvider>
	);
	await render(connected(false));
	const node = sidebar.current;
	await render(connected(true));
	await frame();
	assert.equal(sidebar.current, node);
	assert.equal(progress(), "0");
});
