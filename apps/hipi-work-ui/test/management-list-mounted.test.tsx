// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ManagementCursorList } from "../src/components/management-list/cursor-list.ts";
import { ManagementList } from "../src/components/management-list/management-list.tsx";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.tagName === "SECTION" ? 100 : 0;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.querySelectorAll("[data-management-key]").length * 80 + 64;
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const region = this.closest("section");
		const rows = [...(region?.querySelectorAll("[data-management-key]") ?? [])];
		const index = rows.indexOf(this);
		const top = index < 0 ? 0 : index * 80 - (region?.scrollTop ?? 0);
		return { x: 0, y: top, top, bottom: top + 80, left: 0, right: 100, width: 100, height: 80, toJSON: () => ({}) };
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function mount() {
	const calls: (string | undefined)[] = [];
	const resource = new ManagementCursorList<number>(async (cursor) => {
		calls.push(cursor);
		const index = cursor ? Number(cursor) : 0;
		return { items: [index], nextCursor: index < 8 ? String(index + 1) : null };
	});
	await act(async () =>
		root.render(
			<ManagementList
				resource={resource}
				active
				label="Records"
				loadingLabel="Loading"
				retryLabel="Retry"
				emptyLabel="Empty"
				itemKey={String}
			>
				{(item) => <button type="button">Record {item}</button>}
			</ManagementList>,
		),
	);
	await act(async () => vi.advanceTimersByTimeAsync(100));
	return { resource, calls, region: host.querySelector("section") as HTMLElement };
}
test("near-edge demand loads bounded content without paging controls, preserving focused rows", async () => {
	const { resource, calls, region } = await mount();
	assert.equal(resource.getSnapshot().pages.length, 2);
	await act(async () => {
		region.scrollTop = 150;
		region.dispatchEvent(new Event("scroll"));
	});
	await act(async () => vi.advanceTimersByTimeAsync(50));
	assert.equal(resource.getSnapshot().pages.length, 3);
	const first = host.querySelector("button");
	assert.ok(first);
	first.focus();
	const before = calls.length;
	await act(async () => {
		region.scrollTop = 220;
		region.dispatchEvent(new Event("scroll"));
	});
	assert.equal(calls.length, before, "focused evicted row is retained");
	const last = host.querySelectorAll("button")[2];
	assert.ok(last);
	last.focus();
	await act(async () => {
		region.scrollTop = 221;
		region.dispatchEvent(new Event("scroll"));
	});
	assert.equal(resource.getSnapshot().before, 2, "focus in retained tail does not block keyboard continuation");
	assert.equal(document.activeElement, last);
	assert.equal(host.textContent?.includes("Next"), false);
	for (let index = 0; index < 2; index++)
		await act(async () => {
			region.focus();
			region.scrollTop = 0;
			region.dispatchEvent(new Event("scroll"));
		});
	assert.equal(resource.getSnapshot().before, 0, "earlier evicted content can be read again");
	assert.ok(host.textContent?.includes("Record 0"));
});
test("text selection pauses eviction and deactivation cancels demand while retaining readable records", async () => {
	const { resource, region } = await mount();
	await act(async () => {
		region.scrollTop = 150;
		region.dispatchEvent(new Event("scroll"));
	});
	const text = host.querySelector("button")?.firstChild;
	assert.ok(text);
	const range = document.createRange();
	range.selectNodeContents(text);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	await act(async () => {
		region.scrollTop = 230;
		region.dispatchEvent(new Event("scroll"));
	});
	assert.equal(resource.getSnapshot().before, 0);
	selection?.removeAllRanges();
	await act(async () =>
		root.render(
			<ManagementList
				resource={resource}
				active={false}
				label="Records"
				loadingLabel="Loading"
				retryLabel="Retry"
				emptyLabel="Empty"
				itemKey={String}
			>
				{(item) => <button type="button">Record {item}</button>}
			</ManagementList>,
		),
	);
	const pages = resource.getSnapshot().pages;
	await resource.load();
	assert.equal(resource.getSnapshot().pages, pages);
	assert.ok(host.textContent?.includes("Record 0"));
});
