// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type ReactNode, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider, useThemeSettings } from "../../src/app/theme/provider.tsx";
import { disclosureTransition } from "../../src/components/ui/disclosure-motion.ts";
import { ToolResultDisclosure } from "../../src/features/tool-activities/tool-result-disclosure.tsx";

let host: HTMLDivElement;
let root: Root;
let naturalHeight: number;
let layoutVisible: boolean;
let systemReduced: boolean;
const motionListeners = new Set<() => void>();
const observers: SizeObserver[] = [];

class SizeObserver implements ResizeObserver {
	readonly callback: ResizeObserverCallback;
	target: Element | undefined;
	active = false;
	box: ResizeObserverBoxOptions | undefined;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.push(this);
	}
	observe(target: Element, options?: ResizeObserverOptions) {
		this.target = target;
		this.active = true;
		this.box = options?.box;
	}
	unobserve() {
		this.active = false;
	}
	disconnect() {
		this.active = false;
	}
	deliver(height: number, borderBox = true, target = this.target) {
		assert.ok(target);
		this.callback(
			[
				{
					target,
					borderBoxSize: borderBox ? [{ blockSize: height, inlineSize: 240 }] : [],
					contentBoxSize: [],
					devicePixelContentBoxSize: [],
					contentRect: new DOMRect(0, 0, 240, borderBox ? height - 8 : height),
				},
			],
			this,
		);
	}
}

function PreferenceButtons() {
	const theme = useThemeSettings();
	return (["on", "off", "system"] as const).map((reducedMotion) => (
		<button
			key={reducedMotion}
			type="button"
			data-reduced={reducedMotion}
			onClick={() => theme.preview({ ...theme.config, reducedMotion })}
		>
			{reducedMotion}
		</button>
	));
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", SizeObserver);
	vi.stubGlobal("matchMedia", (query: string) => ({
		get matches() {
			return query === "(prefers-reduced-motion: reduce)" && systemReduced;
		},
		addEventListener(_type: string, listener: () => void) {
			if (query === "(prefers-reduced-motion: reduce)") motionListeners.add(listener);
		},
		removeEventListener(_type: string, listener: () => void) {
			motionListeners.delete(listener);
		},
		addListener() {},
		removeListener() {},
	}));
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	window.localStorage.clear();
	naturalHeight = 120;
	layoutVisible = true;
	systemReduced = false;
	observers.length = 0;
	motionListeners.clear();
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.matches(".inline-tool-result-measure") ? naturalHeight : 0;
	});
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		const rects = layoutVisible && this.isConnected ? [new DOMRect(0, 0, 240, naturalHeight)] : [];
		return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
	});
	// JSDOM has no layout engine. Model normal flow from the real Motion-written
	// numeric shell height, not from whether children happen to remain mounted.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.matches(".inline-tool-result-shell")) return new DOMRect(0, 32, 240, shellHeight());
		if (this.matches("[data-following]")) return new DOMRect(0, 32 + shellHeight(), 240, 24);
		return new DOMRect(0, 0, 240, 999);
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(observers.filter((observer) => observer.active).length, 0);
	host.remove();
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(expanded: boolean, children: ReactNode = <input defaultValue="result" />, identity = "tool") {
	await act(async () => {
		root.render(
			<StrictMode>
				<ThemeProvider>
					<PreferenceButtons />
					<ToolResultDisclosure key={identity} expanded={expanded} id="result">
						{children}
					</ToolResultDisclosure>
					<div data-following="">Following row</div>
				</ThemeProvider>
			</StrictMode>,
		);
	});
}
async function frame(ms = 45) {
	await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}
function element(selector: string) {
	const node = host.querySelector<HTMLElement>(selector);
	assert.ok(node, selector);
	return node;
}
function shellHeight() {
	return Number.parseFloat(element(".inline-tool-result-shell").style.height);
}
function currentObserver() {
	const observer = observers.findLast((entry) => entry.active);
	assert.ok(observer);
	return observer;
}
async function resize(height: number, borderBox = true) {
	naturalHeight = height;
	await act(async () => currentObserver().deliver(height, borderBox));
}
async function preference(value: "on" | "off" | "system") {
	await act(async () => element(`[data-reduced="${value}"]`).click());
}

test("initially closed shell is numeric, empty and inaccessible without observing or mounting a result", async () => {
	const mounted = vi.fn();
	function Result() {
		useEffect(mounted, []);
		return <input defaultValue="result" />;
	}
	await render(false, <Result />);
	const shell = element(".inline-tool-result-shell");
	assert.equal(shell.id, "result");
	assert.equal(shell.style.height, "0px");
	assert.equal(shell.style.opacity, "0");
	assert.equal(shell.style.overflow, "hidden");
	assert.equal(shell.style.pointerEvents, "none");
	assert.equal(shell.dataset.expanded, "false");
	assert.equal(shell.hasAttribute("inert"), true);
	assert.equal(shell.getAttribute("aria-hidden"), "true");
	assert.equal(shell.childElementCount, 0);
	assert.equal(mounted.mock.calls.length, 0);
	assert.equal(observers.length, 0);
	assert.equal(element("[data-following]").getBoundingClientRect().top, 32);
	assert.deepEqual(disclosureTransition, { duration: 0.3, ease: [0.19, 1, 0.22, 1] });
});

test("opening uses initial scrollHeight then border-box and fallback resize without replacing live children", async () => {
	await render(false);
	const shell = element(".inline-tool-result-shell");
	await render(true);
	const input = element("input");
	const measure = element(".inline-tool-result-measure");
	assert.equal(currentObserver().target, measure);
	assert.equal(currentObserver().box, "border-box");
	assert.equal(measure.firstElementChild, element(".inline-tool-result-body"));
	assert.equal(shell.style.overflow, "visible");
	assert.equal(shell.style.pointerEvents, "auto");
	assert.equal(shell.hasAttribute("inert"), false);
	assert.equal(shell.getAttribute("aria-hidden"), "false");
	await frame();
	assert.ok(shellHeight() > 0 && shellHeight() < 120);
	await frame(350);
	assert.equal(shell.style.height, "120px", "initial measurement uses scrollHeight rather than the bounding box");
	assert.equal(shell.style.opacity, "1");
	await resize(220.5);
	await frame();
	assert.ok(shellHeight() > 120 && shellHeight() < 220.5);
	await frame(350);
	assert.equal(shell.style.height, "220.5px", "font or width reflow uses the fractional border-box size");
	assert.equal(element("input"), input);
	await resize(160.25, false);
	await frame(350);
	assert.equal(shell.style.height, "160.25px", "contentRect supplies a missing border-box size");
	assert.equal(element("input"), input);
	assert.equal(element(".inline-tool-result-shell"), shell);
});

test("closing releases ordinary children immediately while the numeric shell and following row still move", async () => {
	const released = vi.fn();
	function Result() {
		useEffect(() => released, []);
		return <input defaultValue="result" />;
	}
	await render(true, <Result />);
	await frame(350);
	const shell = element(".inline-tool-result-shell");
	const following = element("[data-following]");
	const releasesBefore = released.mock.calls.length;
	assert.equal(following.getBoundingClientRect().top, 152);
	await render(false, <Result />);
	assert.equal(host.querySelector("input"), null);
	assert.equal(host.querySelector(".inline-tool-result-measure"), null);
	assert.equal(released.mock.calls.length, releasesBefore + 1);
	assert.equal(observers.filter((observer) => observer.active).length, 0);
	assert.equal(shell.hasAttribute("inert"), true);
	assert.equal(shell.getAttribute("aria-hidden"), "true");
	assert.equal(shell.style.overflow, "hidden");
	assert.equal(shell.style.pointerEvents, "none");
	await frame();
	const closingHeight = shellHeight();
	assert.ok(closingHeight > 0 && closingHeight < 120);
	assert.equal(following.getBoundingClientRect().top, 32 + closingHeight);
	assert.ok(Number.parseFloat(shell.style.opacity) > 0 && Number.parseFloat(shell.style.opacity) < 1);
	await frame(350);
	assert.equal(element(".inline-tool-result-shell"), shell);
	assert.equal(shell.style.height, "0px");
	assert.equal(shell.style.opacity, "0");
	assert.equal(following.getBoundingClientRect().top, 32);
	assert.equal(element("[data-following]"), following);
});

test("rapid reversal continues from the current height and remeasures a newly mounted result", async () => {
	await render(true);
	await frame(350);
	const shell = element(".inline-tool-result-shell");
	const oldInput = element("input");
	await render(false);
	await frame();
	const closingHeight = shellHeight();
	assert.ok(closingHeight > 0 && closingHeight < 120);
	naturalHeight = 200;
	await render(true);
	assert.notEqual(element("input"), oldInput, "individual children do not have the group's retained-exit lifecycle");
	const reversalHeight = shellHeight();
	assert.ok(reversalHeight > 0 && reversalHeight < 120, "reversal does not reset to zero or jump to a target height");
	await frame();
	assert.ok(shellHeight() > reversalHeight && shellHeight() < 200);
	await frame(350);
	assert.equal(element(".inline-tool-result-shell"), shell);
	assert.equal(shell.style.height, "200px");
	assert.equal(shell.style.opacity, "1");
	assert.equal(shell.dataset.expanded, "true");
	assert.equal(shell.hasAttribute("inert"), false);
});

test("stale observer deliveries after close, replacement and unmount cannot change the active shell", async () => {
	await render(true);
	await preference("on");
	await frame();
	const closedObserver = currentObserver();
	await render(false);
	await act(async () => closedObserver.deliver(900));
	naturalHeight = 70;
	await render(true);
	await act(async () => closedObserver.deliver(900));
	await frame();
	assert.equal(shellHeight(), 70);
	const replacedObserver = currentObserver();
	naturalHeight = 85;
	await render(true, <input defaultValue="replacement" />, "replacement");
	assert.equal(replacedObserver.active, false);
	await act(async () => replacedObserver.deliver(800));
	await act(async () => currentObserver().deliver(700, true, document.createElement("div")));
	await frame();
	assert.equal(shellHeight(), 85);
	const unmountedObserver = currentObserver();
	const shell = element(".inline-tool-result-shell");
	await act(async () => root.unmount());
	await act(async () => unmountedObserver.deliver(600));
	await frame();
	assert.equal(unmountedObserver.active, false);
	assert.equal(host.childElementCount, 0);
	assert.equal(shell.style.height, "85px");
});

test("live theme and system reduced-motion changes settle unchanged in-flight targets", async () => {
	await render(true);
	await frame();
	assert.ok(shellHeight() > 0 && shellHeight() < 120);
	const shell = element(".inline-tool-result-shell");
	const input = element("input");
	await preference("on");
	await frame();
	assert.equal(shell.style.height, "120px");
	assert.equal(shell.style.opacity, "1");
	assert.equal(element("input"), input);
	await preference("off");
	await resize(240);
	await frame();
	assert.ok(shellHeight() > 120 && shellHeight() < 240);
	await preference("on");
	await frame();
	assert.equal(shell.style.height, "240px");
	await preference("system");
	await render(false);
	await frame();
	assert.ok(shellHeight() > 0 && shellHeight() < 240);
	await act(async () => {
		systemReduced = true;
		for (const listener of motionListeners) listener();
	});
	await frame();
	assert.equal(shell.style.height, "0px");
	assert.equal(shell.style.opacity, "0");
	assert.equal(host.querySelector("input"), null);
	assert.equal(element(".inline-tool-result-shell"), shell);
	await render(true);
	await frame();
	assert.equal(shell.style.height, "240px");
});

test("hidden measurements preserve natural height while a visible empty body can genuinely become zero", async () => {
	layoutVisible = false;
	naturalHeight = 0;
	await render(true);
	await preference("on");
	await frame();
	assert.equal(shellHeight(), 0);
	layoutVisible = true;
	await resize(110);
	await frame();
	assert.equal(shellHeight(), 110);
	layoutVisible = false;
	await resize(0);
	await frame();
	assert.equal(shellHeight(), 110);
	layoutVisible = true;
	await resize(0);
	await frame();
	assert.equal(shellHeight(), 0);
	assert.equal(element(".inline-tool-result-shell").style.opacity, "1");
	assert.ok(host.querySelector("input"));
});

test("unmounting during motion stops detached shell updates and disconnects measurement", async () => {
	await render(true);
	await frame();
	const shell = element(".inline-tool-result-shell");
	const height = shell.style.height;
	const opacity = shell.style.opacity;
	assert.ok(shellHeight() > 0 && shellHeight() < 120);
	await act(async () => root.unmount());
	await frame(350);
	assert.equal(shell.style.height, height);
	assert.equal(shell.style.opacity, opacity);
	assert.equal(observers.filter((observer) => observer.active).length, 0);
});
