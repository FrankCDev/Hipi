// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { Project } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { HomeProjectPicker } from "../../../src/features/workbench/composer/project-picker.tsx";

vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
const transport = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({
		call: async () => {
			transport.calls++;
			return {
				items: [],
				nextCursor: null,
				previousCursor: null,
				metadataGeneration: 0,
				orderGeneration: 0,
			};
		},
	}),
}));
const current: Project = { projectId: "one", homeWorkspaceId: "home-one", name: "One", revision: 1 };
const other: Project = { projectId: "two", homeWorkspaceId: "home-two", name: "Two", revision: 1 };

test("real project menu selects verified identities, supports projectless, and Escape returns focus", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const onSelect = vi.fn();
	const cache = new QueryClient();
	transport.calls = 0;
	const sidebar = {
		pages: [{ items: [], previousCursor: null, nextCursor: "sidebar-only" }],
		pageParams: ["sidebar-anchor"],
	};
	cache.setQueryData(["projects", "pages"], sidebar);
	// Current identity is always represented, including when absent from the loaded catalog page.
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={cache}>
					<HomeProjectPicker current={current} disabled={false} allowProjectless onSelect={onSelect} />
				</QueryClientProvider>,
			),
		);
		assert.equal(transport.calls, 0, "closed picker does not read catalog");
		const trigger = host.querySelector("button");
		assert.ok(trigger);
		await act(async () => {
			trigger.focus();
			trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		assert.ok(document.querySelector('[role="menu"]'));
		assert.equal(transport.calls, 1);
		assert.deepEqual(cache.getQueryData(["projects", "pages"]), sidebar, "picker cannot evict sidebar window");
		assert.doesNotMatch(document.querySelector('[role="menu"]')?.textContent ?? "", /nav.refresh|loadMore|firstPage/);
		const currentOption = [...document.querySelectorAll('[role="menuitemradio"]')].find(
			(node) => node.textContent === "One",
		);
		assert.equal(currentOption?.getAttribute("aria-checked"), "true");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		assert.equal(onSelect.mock.calls.length, 0);
		await act(async () => {
			trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		const projectless = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
			(node) => node.textContent === "No project",
		);
		assert.ok(projectless);
		await act(async () => projectless.click());
		assert.deepEqual(onSelect.mock.calls, [[null]]);
		await act(async () =>
			root.render(
				<QueryClientProvider client={cache}>
					<HomeProjectPicker current={other} disabled allowProjectless={false} onSelect={onSelect} />
				</QueryClientProvider>,
			),
		);
		assert.equal(host.querySelector("button")?.disabled, true);
		assert.equal(host.textContent, "Two");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		cache.clear();
		vi.unstubAllGlobals();
	}
});
