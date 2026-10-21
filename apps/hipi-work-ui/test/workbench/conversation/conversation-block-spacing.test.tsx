// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";

test("measured row spacing follows logical history, not the virtual window edge", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const style = document.createElement("style");
	style.textContent = readFileSync(
		new NodeURL("../../../src/features/workbench/conversation/conversation-block-spacing.css", import.meta.url),
		"utf8",
	);
	document.head.append(style);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (indexes: number[], count: number) => {
		await act(async () =>
			root.render(
				indexes.map((index) => (
					<div key={index} className="virtual-message-row" data-transcript-last={index === count - 1} />
				)),
			),
		);
	};
	try {
		await render([8, 9], 20);
		const windowEnd = host.lastElementChild;
		assert.ok(windowEnd);
		assert.equal(getComputedStyle(windowEnd).paddingBlockEnd, "var(--ui-conversation-item-gap)");
		await render([18, 19], 20);
		const previousLast = host.lastElementChild;
		assert.ok(previousLast);
		assert.equal(getComputedStyle(previousLast).paddingBlockEnd, "0px");
		await render([18, 19, 20], 21);
		assert.equal(host.children[1], previousLast);
		assert.equal(getComputedStyle(previousLast).paddingBlockEnd, "var(--ui-conversation-item-gap)");
		const nextLast = host.lastElementChild;
		assert.ok(nextLast);
		assert.equal(getComputedStyle(nextLast).paddingBlockEnd, "0px");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		style.remove();
		vi.unstubAllGlobals();
	}
});

test("tool-only rows have no extra boundary; text and status introduce exactly one boundary", () => {
	const style = document.createElement("style");
	style.textContent = [
		"../../../src/features/tool-activities/activity-transcript.css",
		"../../../src/features/workbench/conversation/conversation-block-spacing.css",
	]
		.map((path) => readFileSync(new NodeURL(path, import.meta.url), "utf8"))
		.join("\n");
	document.head.append(style);
	const host = document.createElement("div");
	document.body.append(host);
	host.innerHTML =
		'<article class="message" data-has-message-text="false"><div class="message-content"><h4 hidden>Assistant</h4><div class="message-text"></div><div class="inline-activity"></div></div></article>';
	const article = host.firstElementChild;
	assert.ok(article);
	const content = article.firstElementChild;
	assert.ok(content);
	const tool = content.lastElementChild;
	assert.ok(tool);
	try {
		assert.equal(getComputedStyle(tool).getPropertyValue("--activity-chevron-size"), "14px");
		assert.equal(getComputedStyle(tool).marginBlock, "0px");
		assert.equal(Number.parseFloat(getComputedStyle(tool).marginBlockStart), 0);
		article.setAttribute("data-has-message-text", "true");
		assert.equal(getComputedStyle(tool).marginBlockStart, "var(--ui-conversation-item-gap)");
		article.setAttribute("data-has-message-text", "false");
		const status = document.createElement("div");
		status.className = "response-status";
		content.insertBefore(status, tool);
		assert.equal(getComputedStyle(tool).marginBlockStart, "var(--ui-conversation-item-gap)");
		article.setAttribute("data-has-message-text", "true");
		assert.equal(getComputedStyle(tool).marginBlockStart, "var(--ui-conversation-item-gap)");
		status.remove();
		article.setAttribute("data-has-message-text", "false");
		assert.equal(Number.parseFloat(getComputedStyle(tool).marginBlockStart), 0);
	} finally {
		host.remove();
		style.remove();
	}
});

test("compact file rows use the source icon gap without widening summary words", () => {
	const style = document.createElement("style");
	style.textContent = readFileSync(
		new NodeURL("../../../src/features/tool-activities/inline-activity-card.css", import.meta.url),
		"utf8",
	);
	document.head.append(style);
	const host = document.createElement("div");
	host.innerHTML =
		'<div class="inline-file-activity-row"><svg></svg><button>Read</button><button>example.txt</button></div>';
	document.body.append(host);
	try {
		const row = host.firstElementChild;
		const icon = row?.firstElementChild;
		assert.ok(row && icon);
		assert.equal(getComputedStyle(row).gap, "var(--ui-conversation-grouped-gap)");
		assert.equal(
			getComputedStyle(row).getPropertyValue("--file-activity-icon-gap").replace(/\s/g, ""),
			"calc(var(--spacing)*1.5)",
		);
		assert.equal(
			getComputedStyle(icon).marginInlineEnd,
			"calc(var(--file-activity-icon-gap) - var(--ui-conversation-grouped-gap))",
		);
	} finally {
		host.remove();
		style.remove();
	}
});
