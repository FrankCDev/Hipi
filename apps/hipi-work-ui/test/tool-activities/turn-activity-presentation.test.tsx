// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivityDisclosure } from "../../src/features/tool-activities/turn-activity-presentation.tsx";

test("a held plain summary keeps title, icon and count coherent until the active key's dwell ends", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = (plain: boolean) =>
		act(async () =>
			root.render(
				<ThemeProvider>
					<ActivityDisclosure
						title={plain ? "Worked" : "generic_tool"}
						count={2}
						expanded={false}
						onToggle={() => {}}
						plainSummary={plain}
						active={!plain}
						toolName={plain ? undefined : "generic_tool"}
						status={plain ? undefined : "Running"}
						summaryKey={plain ? "summary" : "active:1"}
						summaryTransition={plain ? "immediate" : "deferred"}
					>
						<p>Result</p>
					</ActivityDisclosure>
				</ThemeProvider>,
			),
		);
	const assertPlain = () => {
		assert.equal(host.querySelector(".activity-disclosure-summary")?.textContent, "Worked");
		assert.equal(host.querySelector(".activity-disclosure-heading svg"), null);
		assert.equal(host.querySelector(".inline-activity-count"), null);
		assert.equal(host.querySelector(".inline-activity-phase"), null);
	};
	try {
		await render(true);
		assertPlain();
		await act(async () => vi.advanceTimersByTime(200));
		await render(false);
		assertPlain();
		await act(async () => vi.advanceTimersByTime(799));
		assertPlain();
		await act(async () => vi.advanceTimersByTime(1));
		assert.equal(
			host.querySelector(".activity-disclosure-summary .cadenced-text")?.firstChild?.textContent,
			"generic_tool",
		);
		assert.ok(host.querySelector(".activity-disclosure-heading svg.lucide-puzzle"));
		assert.equal(host.querySelector(".inline-activity-count")?.textContent, "2");
		assert.equal(host.querySelector(".inline-activity-phase")?.textContent, "Running");
		await render(true);
		assertPlain();
	} finally {
		await act(async () => root.unmount());
		host.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	}
});

test("tool disclosure keeps a stable labelled body, inert collapse and separate summary/accessory geometry", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	const host = document.createElement("div");
	const style = document.createElement("style");
	style.textContent = readFileSync(
		new NodeURL("../../src/features/tool-activities/activity-transcript.css", import.meta.url),
		"utf8",
	);
	document.head.append(style);
	document.body.append(host);
	const root = createRoot(host);
	let toggles = 0;
	const render = async (expanded: boolean, active: boolean, bodyVariant: "default" | "grouped" = "default") => {
		await act(async () =>
			root.render(
				<ThemeProvider>
					<ActivityDisclosure
						title={"Long tool name ".repeat(30)}
						count={2}
						status="Waiting for approval"
						active={active}
						bodyVariant={bodyVariant}
						expanded={expanded}
						onToggle={() => {
							toggles++;
						}}
					>
						<button type="button">Inspect output</button>
					</ActivityDisclosure>
				</ThemeProvider>,
			),
		);
	};
	try {
		await render(true, true);
		const button = host.querySelector<HTMLButtonElement>(".activity-disclosure-toggle");
		assert.ok(button);
		const disclosure = button.parentElement;
		assert.ok(disclosure);
		assert.equal(getComputedStyle(disclosure).display, "flex");
		assert.equal(getComputedStyle(disclosure).flexDirection, "column");
		assert.equal(Number.parseFloat(getComputedStyle(disclosure).minWidth), 0);
		assert.equal(getComputedStyle(button).alignSelf, "flex-start");
		assert.equal(getComputedStyle(button).maxWidth, "100%");
		assert.equal(Number.parseFloat(getComputedStyle(button).padding), 0);
		const body = document.getElementById(button.getAttribute("aria-controls") ?? "");
		assert.ok(body);
		const heading = host.querySelector<HTMLElement>(".activity-disclosure-heading");
		const summary = host.querySelector<HTMLElement>(".activity-disclosure-summary");
		assert.ok(heading && summary);
		assert.ok(heading.querySelector('svg.lucide-puzzle[aria-hidden="true"]'));
		assert.equal(Number.parseFloat(getComputedStyle(heading).minWidth), 0);
		assert.equal(getComputedStyle(summary).textOverflow, "ellipsis");
		assert.notEqual(getComputedStyle(button).gap, getComputedStyle(heading).gap);
		assert.equal(getComputedStyle(body).overflow, "hidden");
		assert.equal(body.hasAttribute("inert"), false);
		await act(async () => button.click());
		assert.equal(toggles, 1);
		await render(false, false);
		assert.equal(document.getElementById(button.getAttribute("aria-controls") ?? ""), body);
		assert.equal(body.getAttribute("aria-hidden"), "true");
		assert.equal(body.hasAttribute("inert"), true);
		assert.equal(getComputedStyle(body).overflow, "hidden");
		assert.equal(body.style.pointerEvents, "none");
		assert.equal(host.querySelector<HTMLElement>(".cadenced-text")?.dataset.animate, "false");
		await render(true, false, "grouped");
		const details = host.querySelector(".inline-activity-details");
		assert.ok(details);
		assert.equal(getComputedStyle(details).getPropertyValue("--activity-body-indent"), "0");
		assert.equal(
			getComputedStyle(details).getPropertyValue("--activity-body-padding-start"),
			"var(--ui-conversation-grouped-gap)",
		);
		assert.equal(body.hasAttribute("inert"), false);
		const legacy = document.createElement("div");
		legacy.className = "inline-activity";
		const legacyToggle = document.createElement("button");
		legacyToggle.className = "inline-activity-toggle";
		legacy.append(legacyToggle);
		host.append(legacy);
		assert.notEqual(getComputedStyle(legacy).display, "flex", "metadata-only wrappers keep their existing layout");
		assert.notEqual(
			getComputedStyle(legacyToggle).alignSelf,
			"flex-start",
			"the shared elapsed/metadata toggle does not receive the tool-only alignment",
		);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		style.remove();
		vi.unstubAllGlobals();
	}
});

test("real Motion keeps opening and reversing tool content clipped beside a stable normal-flow answer", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let reduced = false;
	let naturalHeight = 240;
	vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const height = Number.parseFloat(this.style.height);
		return new DOMRect(0, 0, 800, Number.isFinite(height) ? height : naturalHeight);
	});
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		return [this.getBoundingClientRect()] as unknown as DOMRectList;
	});
	const host = document.createElement("div");
	const style = document.createElement("style");
	style.textContent =
		readFileSync(new NodeURL("../../src/features/tool-activities/activity-transcript.css", import.meta.url), "utf8") +
		".activity-disclosure-body { box-sizing: border-box; }";
	document.head.append(style);
	document.body.append(host);
	const root = createRoot(host);
	const render = async (expanded: boolean) => {
		await act(async () =>
			root.render(
				<ThemeProvider>
					<div data-same-turn="">
						<ActivityDisclosure title="Read file" count={1} expanded={expanded} onToggle={() => {}}>
							<p>Canonical tool output</p>
						</ActivityDisclosure>
						<p data-following-answer="">Following answer</p>
					</div>
				</ThemeProvider>,
			),
		);
	};
	const frame = async (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
	try {
		await render(false);
		const header = host.querySelector<HTMLButtonElement>(".activity-disclosure-toggle");
		const answer = host.querySelector("[data-following-answer]");
		assert.ok(header && answer);
		assert.equal(host.querySelector(".activity-disclosure-body"), null);
		header.focus();
		const range = document.createRange();
		range.selectNodeContents(answer);
		document.getSelection()?.removeAllRanges();
		document.getSelection()?.addRange(range);
		assert.equal(document.getSelection()?.toString(), "Following answer");
		await render(true);
		const body = host.querySelector<HTMLElement>(".activity-disclosure-body");
		assert.ok(body);
		assert.equal(getComputedStyle(body).overflow, "hidden", "clip from the first expanded render, not completion");
		// React's act batches the opening RAF state update until this wait ends.
		// Flush that phase before sampling Motion's separate interpolation frames.
		await frame(25);
		assert.equal(body.parentElement?.getAttribute("data-disclosure-phase"), "expanded");
		await frame(60);
		const openingHeight = Number.parseFloat(body.style.height);
		assert.ok(openingHeight > 0 && openingHeight < naturalHeight, `real animated opening height ${openingHeight}`);
		assert.equal(getComputedStyle(body).overflow, "hidden");
		await render(false);
		await frame(35);
		assert.equal(body.hasAttribute("inert"), true);
		assert.equal(getComputedStyle(body).overflow, "hidden");
		await render(true);
		await frame(400);
		assert.equal(body.style.height, "auto");
		assert.equal(body.style.opacity, "1");
		assert.equal(getComputedStyle(body).overflow, "hidden");
		naturalHeight = 360;
		await render(true);
		assert.equal(body.getBoundingClientRect().height, 360, "settled auto height accepts asynchronous content growth");
		assert.equal(host.querySelector(".activity-disclosure-body"), body);
		assert.equal(host.querySelector("[data-following-answer]"), answer);
		assert.equal(host.querySelectorAll(".activity-disclosure-body").length, 1);
		assert.equal(body.parentElement?.nextElementSibling, answer);
		assert.equal(document.activeElement, header);
		assert.equal(document.getSelection()?.toString(), "Following answer");
		reduced = true;
		await render(false);
		assert.equal(host.querySelector(".activity-disclosure-body"), null);
		await render(true);
		const reducedBody = host.querySelector<HTMLElement>(".activity-disclosure-body");
		assert.ok(reducedBody);
		assert.equal(reducedBody.parentElement?.getAttribute("data-disclosure-phase"), "expanded");
		assert.equal(reducedBody.style.height, "auto");
		assert.equal(reducedBody.hasAttribute("inert"), false, "reduced motion opens immediately without an opening frame");
	} finally {
		await act(async () => root.unmount());
		document.getSelection()?.removeAllRanges();
		host.remove();
		style.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

test("real Motion retargets async opening endpoints and releases settled groups to child-owned auto layout", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let reduced = false;
	let naturalHeight = 28;
	let visible = true;
	vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const height = Number.parseFloat(this.style.height);
		return new DOMRect(0, 0, 800, Number.isFinite(height) ? height : naturalHeight);
	});
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		return (visible ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(999);
	const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; node?: Element }>();
	const retired: (() => void)[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.set(this as unknown as ResizeObserver, { callback });
			}
			observe(node: Element) {
				const entry = observers.get(this as unknown as ResizeObserver);
				if (entry) entry.node = node;
			}
			disconnect() {
				const instance = this as unknown as ResizeObserver;
				const entry = observers.get(instance);
				if (entry?.node)
					retired.push(() =>
						entry.callback(
							[{ target: entry.node, borderBoxSize: [{ blockSize: naturalHeight }] } as unknown as ResizeObserverEntry],
							instance,
						),
					);
				observers.delete(instance);
			}
		},
	);
	const resize = async (height: number) =>
		act(async () => {
			naturalHeight = height;
			for (const [instance, { callback, node }] of observers) {
				if (node)
					callback(
						[{ target: node, borderBoxSize: [{ blockSize: height }] } as unknown as ResizeObserverEntry],
						instance,
					);
			}
		});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let mounts = 0,
		releases = 0;
	function Reader() {
		useEffect(() => {
			mounts++;
			return () => {
				releases++;
			};
		}, []);
		return <p>{naturalHeight === 28 ? "Loading" : "Several loaded metadata rows"}</p>;
	}
	const render = async (expanded: boolean) =>
		act(async () =>
			root.render(
				<ThemeProvider>
					<ActivityDisclosure title="Tools" count={6} expanded={expanded} onToggle={() => {}} bodyVariant="grouped">
						<Reader />
					</ActivityDisclosure>
					<p data-answer="">Following answer</p>
				</ThemeProvider>,
			),
		);
	const wait = async (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
	const heights: number[] = [];
	try {
		await render(false);
		await render(true);
		await wait(25);
		await wait(60);
		const body = host.querySelector<HTMLElement>(".activity-disclosure-body");
		assert.ok(body);
		await resize(208);
		await render(true);
		await wait(40);
		await resize(96);
		await wait(40);
		await resize(208);
		for (let index = 0; index < 18; index++) {
			await wait(20);
			heights.push(body.getBoundingClientRect().height);
		}
		assert.ok(
			heights.some((height) => height > 28 && height < 207),
			"loaded height is approached during opening, not installed as a terminal step",
		);
		assert.equal(body.style.height, "auto");
		assert.equal(body.getBoundingClientRect().height, 208, "bounded border box wins over scrollHeight=999");
		const lastNumeric = heights.findLast((height) => height < 208);
		assert.ok(
			lastNumeric !== undefined && 208 - lastNumeric < 2,
			"the final numeric-to-auto boundary has no stale loading-height jump",
		);
		assert.equal(observers.size, 0, "settled parent stops retargeting descendant output animation");
		await resize(220);
		await render(true);
		assert.equal(body.style.height, "auto");
		assert.equal(body.getBoundingClientRect().height, 220);
		await render(false);
		await wait(65);
		assert.equal(releases, 0, "close retains the sole details reader");
		await resize(40);
		await render(true);
		await wait(60);
		await resize(198);
		await wait(250);
		assert.equal(
			host.querySelector(".activity-disclosure-body"),
			body,
			"stopped close completion cannot unmount a reversal",
		);
		await wait(120);
		assert.equal(body.style.height, "auto");
		assert.equal(mounts, 1);
		await render(false);
		await wait(400);
		assert.equal(releases, 1);
		assert.equal(host.querySelector(".activity-disclosure-body"), null);
		visible = false;
		await render(true);
		await wait(25);
		await resize(0);
		await wait(60);
		const hiddenBody = host.querySelector<HTMLElement>(".activity-disclosure-body");
		assert.ok(hiddenBody);
		assert.equal(hiddenBody.style.height, "0px", "hidden ancestor is not a settled zero-height endpoint");
		visible = true;
		await resize(180);
		await wait(60);
		assert.ok(Number.parseFloat(hiddenBody.style.height) > 0);
		reduced = true;
		await render(true);
		assert.equal(
			hiddenBody.style.height,
			"auto",
			"live reduced-motion change settles the current endpoint immediately",
		);
		assert.equal(observers.size, 0);
		await act(async () => {
			for (const callback of retired) callback();
		});
		assert.equal(
			hiddenBody.style.height,
			"auto",
			"stale observer delivery cannot restart a settled or cancelled transition",
		);
	} finally {
		await act(async () => root.unmount());
		assert.equal(mounts, releases);
		assert.equal(observers.size, 0);
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

test("controlled disclosure cancels unopened frames and releases its sole child on cancellation or unmount", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	let frameId = 0;
	const frames = new Map<number, FrameRequestCallback>();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let mounts = 0;
	let releases = 0;
	function Reader() {
		useEffect(() => {
			mounts++;
			return () => {
				releases++;
			};
		}, []);
		return <input aria-label="retained tool input" defaultValue="draft" />;
	}
	const render = async (expanded: boolean) =>
		act(async () =>
			root.render(
				<ThemeProvider>
					<ActivityDisclosure title="Tool" count={1} expanded={expanded} onToggle={() => {}}>
						<Reader />
					</ActivityDisclosure>
				</ThemeProvider>,
			),
		);
	try {
		await render(false);
		assert.equal(mounts, 0);
		await render(true);
		assert.equal(host.querySelector(".inline-activity")?.getAttribute("data-disclosure-phase"), "opening");
		assert.equal(mounts, 1);
		assert.equal(frames.size, 1);
		const cancelled = [...frames.values()];
		await render(false);
		assert.equal(frames.size, 0);
		assert.equal(releases, 1);
		assert.equal(host.querySelector("input"), null);
		await act(async () => {
			for (const callback of cancelled) callback(performance.now());
		});
		assert.equal(host.querySelector("input"), null, "a cancelled opening frame must not revive the body");
		await render(true);
		assert.equal(mounts, 2);
		await act(async () => root.unmount());
		assert.equal(frames.size, 0);
		assert.equal(releases, 2);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
