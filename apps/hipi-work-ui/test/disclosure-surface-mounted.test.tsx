// @vitest-environment jsdom
import assert from "node:assert/strict";
import { usePresence } from "framer-motion";
import { act, createRef, type ReactNode, StrictMode, useEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { disclosureTransition } from "../src/components/ui/disclosure-motion.ts";
import { DisclosureSurface } from "../src/components/ui/disclosure-surface.tsx";

let root: Root;
let host: HTMLDivElement;
let naturalHeight = 60;
let visible = true;
const observers = new Set<ResizeObserverCallback>();
const region = createRef<HTMLElement>();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	naturalHeight = 60;
	visible = true;
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		return (visible && !this.closest("[hidden]") ? [{ height: naturalHeight }] : []) as unknown as DOMRectList;
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, 200, naturalHeight),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {}
			observe() {
				observers.add(this.callback);
			}
			disconnect() {
				observers.delete(this.callback);
			}
		},
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(observers.size, 0);
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(expanded: boolean, reduced = false, children: ReactNode = <input defaultValue="draft" />) {
	await act(async () => {
		root.render(
			<StrictMode>
				<DisclosureSurface ref={region} expanded={expanded} reduced={reduced} id="project" data-query="stable">
					{children}
				</DisclosureSurface>
			</StrictMode>,
		);
	});
}
async function frame(ms = 50) {
	await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}
async function resize(height: number) {
	naturalHeight = height;
	await act(async () => {
		for (const observer of observers) observer([], {} as ResizeObserver);
	});
}
function surface() {
	return host.querySelector<HTMLElement>("[data-disclosure-motion]");
}

test("disclosure uses the shared duration and easing, not a spring", () => {
	assert.deepEqual(disclosureTransition, { duration: 0.3, ease: [0.19, 1, 0.22, 1] });
});
test("initial expanded content is visible; a later expansion and resize interpolate measured height", async () => {
	await render(true);
	assert.equal(surface()?.style.opacity, "1");
	assert.notEqual(surface()?.style.height, "0px");
	await render(false, true);
	await frame();
	await render(true);
	await frame(45);
	const enteringHeight = Number.parseFloat(surface()?.style.height ?? "");
	assert.ok(enteringHeight > 0 && enteringHeight < 60, `entering height ${enteringHeight}`);
	await frame(350);
	await resize(180);
	await frame(45);
	const resizingHeight = Number.parseFloat(surface()?.style.height ?? "");
	assert.ok(resizingHeight > 60 && resizingHeight < 180, `resizing height ${resizingHeight}`);
	await frame(350);
	assert.equal(surface()?.style.height, "180px");
});
test("collapse is immediately inaccessible, retains only the exit, then removes ordinary descendants", async () => {
	await render(true);
	await frame(400);
	const section = region.current;
	const input = host.querySelector("input");
	assert.ok(section && input);
	await render(false);
	assert.equal(region.current, section);
	assert.equal(section.hasAttribute("inert"), true);
	assert.equal(section.getAttribute("aria-hidden"), "true");
	assert.equal(section.hidden, false);
	assert.equal(host.querySelector("input"), input);
	await frame(400);
	assert.equal(section.hidden, true);
	assert.equal(host.querySelector("input"), null);
	assert.equal(observers.size, 0);
});
test("rapid reopening retains the exact body and ignores obsolete exit completion", async () => {
	await render(true);
	await frame(400);
	const input = host.querySelector("input");
	assert.ok(input);
	input.value = "unsaved";
	await render(false);
	await frame(45);
	await render(true);
	await frame(400);
	assert.equal(host.querySelector("input"), input);
	assert.equal(input.value, "unsaved");
	assert.equal(region.current?.hidden, false);
	assert.equal(region.current?.hasAttribute("inert"), false);
	assert.equal(surface()?.style.opacity, "1");
});
test("enabling reduced motion during an exit settles it without remounting the section", async () => {
	await render(true);
	await frame(400);
	const section = region.current;
	await render(false);
	await frame(40);
	await render(false, true);
	await frame(60);
	assert.equal(region.current, section);
	assert.equal(section?.hidden, true);
	assert.equal(surface(), null);
});
test("initially closed body is absent; reopening measures new content and observes subsequent layout changes", async () => {
	await render(false, true);
	assert.equal(host.querySelector("input"), null);
	assert.equal(region.current?.hidden, true);
	naturalHeight = 90;
	await render(true, true);
	await frame();
	assert.equal(surface()?.style.height, "90px");
	await resize(120);
	await frame();
	assert.equal(surface()?.style.height, "120px");
	visible = false;
	await resize(0);
	await frame();
	assert.equal(surface()?.style.height, "120px");
	visible = true;
	await resize(0);
	await frame();
	assert.equal(surface()?.style.height, "0px");
	await render(false, true);
	await frame();
	assert.equal(surface(), null);
});

let release: (() => void) | undefined;
function DialogOwner() {
	const [present, safeToRemove] = usePresence();
	useEffect(() => {
		release = !present ? safeToRemove : undefined;
		return () => {
			release = undefined;
		};
	}, [present, safeToRemove]);
	return createPortal(<input aria-label="rename" defaultValue="pending rename" />, document.body);
}
test("a descendant presence owner can retain its portal without leaving a collapsed layout gap", async () => {
	await render(true, false, <DialogOwner />);
	await frame(400);
	const input = document.querySelector<HTMLInputElement>('[aria-label="rename"]');
	assert.ok(input);
	input.focus();
	input.value = "unsaved rename";
	await render(false, false, <DialogOwner />);
	await frame(400);
	assert.equal(region.current?.hidden, true);
	assert.equal(document.querySelector('[aria-label="rename"]'), input);
	assert.equal(document.activeElement, input);
	assert.equal(input.value, "unsaved rename");
	assert.ok(release);
	await act(async () => release?.());
	await frame();
	assert.equal(document.querySelector('[aria-label="rename"]'), null);
});
test("reopening an already hidden retained body remeasures current content without remounting its portal", async () => {
	await render(true, false, <DialogOwner />);
	await frame(350);
	const body = surface();
	const input = document.querySelector<HTMLInputElement>('[aria-label="rename"]');
	assert.ok(input && body);
	await render(false, false, <DialogOwner />);
	await frame(350);
	assert.equal(region.current?.hidden, true);
	naturalHeight = 140;
	await render(true, false, <DialogOwner />);
	assert.equal(region.current?.hidden, false);
	assert.equal(surface(), body);
	assert.equal(document.querySelector('[aria-label="rename"]'), input);
	await frame(45);
	const currentHeight = Number.parseFloat(body.style.height);
	assert.ok(currentHeight > 0 && currentHeight < 140);
	await frame(350);
	assert.equal(body.style.height, "140px");
	assert.equal(release, undefined);
});
