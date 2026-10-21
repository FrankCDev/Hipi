// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { ThemeProvider } from "../../src/app/theme/provider.tsx";
import { ActivityDisclosure } from "../../src/features/tool-activities/turn-activity-presentation.tsx";

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
