// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
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
		assert.equal(Number.parseFloat(getComputedStyle(heading).minWidth), 0);
		assert.equal(getComputedStyle(summary).textOverflow, "ellipsis");
		assert.notEqual(getComputedStyle(button).gap, getComputedStyle(heading).gap);
		assert.equal(getComputedStyle(body).overflow, "visible");
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
		assert.equal(getComputedStyle(details).getPropertyValue("--activity-body-padding-start"), "0.25rem");
		assert.equal(body.hasAttribute("inert"), false);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		style.remove();
		vi.unstubAllGlobals();
	}
});
