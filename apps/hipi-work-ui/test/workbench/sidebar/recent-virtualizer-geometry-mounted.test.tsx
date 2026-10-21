// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { SidebarConversation } from "@hipi/work-runtime/contracts";
import { act, StrictMode, useCallback, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useRecentVirtualizer } from "../../../src/features/workbench/sidebar/use-recent-virtualizer.ts";
import { scopeKey } from "../../../src/features/workbench/sidebar/window-query.ts";

// Real mounted React + installed TanStack hook; jsdom has no layout engine.
// Only browser box/ResizeObserver/scroll inputs are controlled. CSS cascade and
// native painted-frame acceptance remain separate checks.
let layout = { height: 30, gap: 1, margin: 72, hidden: false };
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useRecentVirtualizer>;
const paddingStart = 32;
const rows: SidebarConversation[] = Array.from({ length: 600 }, (_, index) => ({
	conversation: {
		workspaceId: "physical",
		conversationId: String(index),
		title: `Conversation ${index}`,
		revision: 1,
		createdAt: 1,
		archivedAt: null,
	},
	membership: { workspaceId: "physical", conversationId: String(index), projectId: null, revision: 1 },
	recencyAt: 1,
	activityBasis: "creation",
}));
const protectedKeys = rows.slice(0, 2).map((row) => scopeKey(row.conversation));

function viewport() {
	const element = host.querySelector<HTMLElement>("[data-viewport]");
	assert.ok(element);
	return element;
}
function rowAt(index: number) {
	const element = host.querySelector<HTMLLIElement>(`[data-index="${index}"]`);
	assert.ok(element, `Row ${index} must be mounted`);
	return element;
}
function box(element: HTMLElement): DOMRect {
	if (layout.hidden) return new DOMRect();
	if (element.hasAttribute("data-viewport")) return new DOMRect(0, 0, 300, 360);
	if (element.hasAttribute("data-recent-geometry")) return new DOMRect(0, 0, layout.gap, layout.height);
	const offset = host.querySelector<HTMLElement>("[data-viewport]")?.scrollTop ?? 0;
	if (element.tagName === "UL")
		return new DOMRect(0, layout.margin - offset, 300, Number.parseFloat(element.style.height) || 0);
	if (element.hasAttribute("data-index"))
		return new DOMRect(0, layout.margin + Number.parseFloat(element.style.top) - offset, 300, layout.height);
	return new DOMRect();
}
const observers = new Set<ResizeObserverStub>();
class ResizeObserverStub {
	readonly targets = new Set<Element>();
	readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		observers.delete(this);
	}
	resize(borderBox = true) {
		const entries = [...this.targets].map((target) => {
			const rect = box(target as HTMLElement);
			const size = [{ inlineSize: rect.width, blockSize: rect.height }];
			const entry = {
				target,
				contentRect: rect,
				borderBoxSize: size,
				contentBoxSize: size,
				devicePixelContentBoxSize: size,
			};
			// Older observer implementations may omit this newer property entirely.
			if (!borderBox) Reflect.deleteProperty(entry, "borderBoxSize");
			return entry;
		});
		this.callback(entries, this);
	}
}
function Fixture({
	count = 600,
	enabled = true,
	mounted = true,
	listKey = "list",
}: {
	count?: number;
	enabled?: boolean;
	mounted?: boolean;
	listKey?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const getViewport = useCallback(() => scrollRef.current, []);
	result = useRecentVirtualizer(
		rows.slice(0, count),
		getViewport,
		protectedKeys,
		enabled,
		paddingStart,
		protectedKeys[0],
	);
	return (
		<div ref={scrollRef} data-viewport="">
			{mounted && (
				<ul key={listKey} ref={result.setList} style={{ height: result.totalSize }}>
					{result.items.map((item) => (
						<li
							key={item.key}
							ref={result.virtualizer.measureElement}
							data-index={item.index}
							style={{ position: "absolute", top: item.start - result.margin }}
						>
							<input aria-label={`Draft ${item.index}`} defaultValue={`Draft ${item.index}`} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	layout = { height: 30, gap: 1, margin: 72, hidden: false };
	observers.clear();
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	host = document.createElement("div");
	document.body.append(host);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
		return box(this);
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
		return box(this).height;
	});
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
		return box(this).width;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
		return this.hasAttribute("data-viewport")
			? layout.margin + (Number.parseFloat(this.querySelector("ul")?.style.height ?? "0") || 0)
			: box(this).height;
	});
	vi.stubGlobal("scrollTo", () => {});
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions) {
			const top = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight));
			if (this.scrollTop === top) return;
			this.scrollTop = top;
			queueMicrotask(() => {
				if (this.isConnected) this.dispatchEvent(new Event("scroll"));
			});
		},
	});
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(
		[...observers].reduce((count, observer) => count + observer.targets.size, 0),
		0,
		"All geometry, viewport and row observation targets are released",
	);
	host.remove();
	Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(count = 600, enabled = true, mounted = true, listKey = "list") {
	await act(async () =>
		root.render(
			<StrictMode>
				<Fixture count={count} enabled={enabled} mounted={mounted} listKey={listKey} />
			</StrictMode>,
		),
	);
}
async function resize() {
	await act(async () => {
		for (const observer of [...observers]) observer.resize();
	});
}
async function scrollTo(index: number, within = 7) {
	await act(async () => {
		viewport().scrollTop = layout.margin + paddingStart + index * (layout.height + layout.gap) + within;
		viewport().dispatchEvent(new Event("scroll"));
	});
}
function verifyGeometry(height: number, gap: number) {
	assert.equal(result.virtualizer.options.estimateSize(550), height);
	assert.equal(result.virtualizer.options.gap, gap);
	assert.equal(result.totalSize, paddingStart + 600 * height + 599 * gap);
	assert.equal(
		result.virtualizer.getOffsetForIndex(550, "start")?.[0],
		layout.margin + paddingStart + 550 * (height + gap),
	);
	assert.ok(host.querySelectorAll("[data-index]").length <= 30, "DOM stays bounded, including protected owners");
}

test("coarse/font/root-size geometry replaces unseen and previously measured extents without moving the deep anchor", async () => {
	await render();
	const owner = rowAt(0);
	const input = owner.querySelector("input");
	assert.ok(input);
	input.value = "Unsubmitted rename";
	input.focus();
	await scrollTo(500);
	const anchor = rowAt(500);
	assert.equal(anchor.getBoundingClientRect().top, -7);
	verifyGeometry(30, 1);
	for (const next of [
		{ height: 44, gap: 1, margin: 72 },
		{ height: 52, gap: 1, margin: 96 },
		{ height: 37.5, gap: 1.25, margin: 90 },
	]) {
		Object.assign(layout, next);
		await resize();
		verifyGeometry(next.height, next.gap);
		assert.equal(rowAt(500), anchor);
		assert.equal(anchor.getBoundingClientRect().top, -7);
		assert.equal(rowAt(0), owner);
		assert.equal(document.activeElement, input);
		assert.equal(input.value, "Unsubmitted rename");
	}
	const probe = host.querySelector<HTMLElement>("[data-recent-geometry]");
	assert.ok(probe);
	assert.equal(probe.style.height, "var(--sidebar-row-height)");
	assert.equal(probe.style.width, "var(--sidebar-row-gap)");
	assert.equal(probe.getAttribute("aria-hidden"), "true");
	assert.equal(probe.inert, true);
	assert.equal(probe.hasAttribute("data-index"), false);
});

test("empty initialization and first-row replacement do not strand geometry observation", async () => {
	layout.height = 44;
	await render(0);
	assert.equal(host.querySelectorAll("[data-index]").length, 0);
	assert.equal(host.querySelectorAll("[data-recent-geometry]").length, 1);
	await render();
	verifyGeometry(44, 1);
	await scrollTo(500);
	assert.equal(host.querySelector("[data-index='3']"), null);
	layout.height = 50;
	await resize();
	verifyGeometry(50, 1);
	assert.equal(rowAt(500).getBoundingClientRect().top, -7);
});

test("disabled geometry changes preserve the retained extent, protected owner and deep anchor until re-enabled", async () => {
	await render();
	await scrollTo(500);
	const owner = rowAt(0);
	const input = owner.querySelector("input");
	assert.ok(input);
	input.value = "Retained draft";
	input.focus();
	const previousExtent = result.totalSize;
	await render(600, false);
	layout.height = 52;
	await resize();
	assert.equal(result.totalSize, previousExtent);
	assert.equal(result.virtualizer.options.count, 600);
	assert.equal(host.querySelectorAll("[data-index]").length, 2);
	assert.equal(rowAt(0), owner);
	assert.equal(input.value, "Retained draft");
	await render();
	verifyGeometry(52, 1);
	assert.equal(rowAt(500).getBoundingClientRect().top, -7);
	assert.equal(rowAt(0), owner);
	assert.equal(document.activeElement, input);
});

test("hidden zero boxes never replace measured geometry, and visibility resumes at the prior scroll position", async () => {
	await render();
	await scrollTo(500);
	const previousExtent = result.totalSize;
	await render(600, false);
	layout.hidden = true;
	await resize();
	assert.equal(result.totalSize, previousExtent);
	assert.equal(result.virtualizer.options.estimateSize(550), 30);
	layout.hidden = false;
	await render();
	verifyGeometry(30, 1);
	assert.equal(rowAt(500).getBoundingClientRect().top, -7);
});

test("initially absent and replaced list nodes attach their own probe and release the previous observer", async () => {
	await render(600, false, false);
	assert.equal(host.querySelectorAll("[data-recent-geometry]").length, 0);
	await render();
	verifyGeometry(30, 1);
	const previous = host.querySelector("[data-recent-geometry]");
	assert.ok(previous);
	await render(600, false, false);
	assert.equal(previous.isConnected, false);
	assert.equal(
		[...observers].some((observer) => observer.targets.has(previous)),
		false,
	);
	layout.height = 44;
	await render();
	verifyGeometry(44, 1);
	assert.equal(host.querySelectorAll("[data-recent-geometry]").length, 1);
	const reopened = host.querySelector("[data-recent-geometry]");
	layout.height = 50;
	await render(600, true, true, "replacement");
	verifyGeometry(50, 1);
	assert.notEqual(host.querySelector("[data-recent-geometry]"), reopened);
	assert.equal(host.querySelectorAll("[data-recent-geometry]").length, 1);
});

test("initial hidden layout waits for positive geometry instead of mounting placeholder-sized rows", async () => {
	layout.hidden = true;
	await render();
	assert.equal(result.virtualizer.options.enabled, false);
	assert.equal(host.querySelectorAll("[data-index]").length, 0);
	assert.equal(result.totalSize, paddingStart);
	layout.hidden = false;
	layout.height = 44;
	await resize();
	assert.equal(result.virtualizer.options.enabled, true);
	verifyGeometry(44, 1);
});

test("ResizeObserver entries without borderBoxSize fall back to actual row boxes", async () => {
	await render();
	await scrollTo(500);
	layout.height = 44;
	await act(async () => {
		for (const observer of [...observers]) observer.resize(false);
	});
	verifyGeometry(44, 1);
	assert.equal(rowAt(500).getBoundingClientRect().top, -7);
});

test("new scroll intent cancels a geometry anchor deferred while observation is disabled", async () => {
	await render();
	await scrollTo(500);
	await render(600, false);
	layout.height = 44;
	await resize();
	viewport().dispatchEvent(new Event("wheel"));
	await scrollTo(250);
	await render();
	verifyGeometry(44, 1);
	assert.equal(rowAt(250).getBoundingClientRect().top, -7);
	assert.equal(host.querySelector("[data-index='500']"), null);
});
