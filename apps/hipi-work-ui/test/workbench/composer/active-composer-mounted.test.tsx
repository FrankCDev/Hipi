// @vitest-environment jsdom
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ConversationComposer } from "../../../src/features/workbench/composer/input.tsx";
import { ConversationModelControls } from "../../../src/features/workbench/conversation/model.tsx";
import type { ConversationController } from "../../../src/features/workbench/conversation/use-conversation.ts";

vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ t: (key: string) => key, locale: "en" }),
}));
vi.mock("../../../src/features/workbench/conversation/receipt.tsx", () => ({ ReceiptRecovery: () => null }));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: async () => ({ models: [], providers: [] }) }),
}));
let host: HTMLDivElement;
let cache: QueryClient;
let root: Root;
const submit = vi.fn();
const cancel = vi.fn();
function controller({ running = false, pending = false, text = "draft", blocked = false } = {}) {
	return {
		draft: text,
		setDraft: vi.fn(),
		submit,
		blocked,
		composing: { current: false },
		mutation: { isPending: !running && pending, isError: false },
		execution: { isPending: running && pending, isError: false, mutate: cancel },
		model: {
			data: {
				executionState: running ? "running" : "ready",
				model: { provider: "custom", modelId: "reference-model" },
				credentialState: "configured",
			},
			isError: false,
		},
		receipt: { isError: false },
		storageAvailable: true,
	} as unknown as ConversationController;
}
async function render(options = {}) {
	await act(async () =>
		root.render(
			<ConversationComposer
				controller={controller(options)}
				controls={
					<button type="button" data-control>
						Model
					</button>
				}
			/>,
		),
	);
}
function query<T extends Element = HTMLElement>(selector: string, parent: Element = host): T {
	const element = parent.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
function action() {
	return query<HTMLButtonElement>(".composer-submit");
}
function editor() {
	return query('[role="textbox"]');
}
function pointer(target: Element, button = 0) {
	const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button });
	target.dispatchEvent(event);
	return event;
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	submit.mockClear();
	cancel.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	cache.clear();
	host.remove();
	vi.unstubAllGlobals();
});
test("send and stop use true pending state, busy semantics and no native tooltip", async () => {
	await render();
	assert.equal(action().disabled, false);
	assert.equal(action().title, "");
	await act(async () => action().click());
	assert.equal(submit.mock.calls.length, 1);
	await render({ pending: true });
	assert.equal(action().disabled, true);
	assert.equal(action().getAttribute("aria-busy"), "true");
	assert.ok(action().querySelector(".composer-pending-icon"));
	await render({ running: true });
	assert.equal(action().dataset.action, "stop");
	assert.equal(action().getAttribute("aria-busy"), null);
	await act(async () => action().click());
	assert.deepEqual(cancel.mock.calls, [["cancel"]]);
	await render({ running: true, pending: true });
	assert.equal(action().disabled, true);
	assert.ok(action().querySelector(".composer-pending-icon"));
	await act(async () => action().click());
	assert.equal(cancel.mock.calls.length, 1);
});
test("empty and blocked drafts cannot submit and pending renders preserve editor identity", async () => {
	await render({ text: "" });
	assert.equal(action().disabled, true);
	await render({ blocked: true });
	assert.equal(action().disabled, true);
	const node = editor();
	await render({ pending: true });
	assert.equal(editor(), node);
	assert.equal(editor().textContent, "draft");
});
test("noninteractive shell whitespace focuses existing editor; editor and controls keep pointer ownership", async () => {
	await render();
	const node = editor();
	await act(async () => {
		assert.equal(pointer(query(".composer")).defaultPrevented, true);
	});
	assert.equal(document.activeElement, node);
	const control = query<HTMLButtonElement>("[data-control]");
	control.focus();
	await act(async () => {
		assert.equal(pointer(control).defaultPrevented, false);
	});
	assert.equal(document.activeElement, control);
	assert.equal(pointer(query(".composer"), 2).defaultPrevented, false);
	assert.equal(document.activeElement, control);
	assert.equal(pointer(query("p", node)).defaultPrevented, false);
});

test("actual model status remains a usable popup beside the composer primary action", async () => {
	const state = controller();
	await act(async () =>
		root.render(
			<QueryClientProvider client={cache}>
				<ConversationComposer controller={state} expandingControls={<ConversationModelControls controller={state} />} />
			</QueryClientProvider>,
		),
	);
	const trigger = query<HTMLButtonElement>(".model-status-trigger");
	assert.equal(trigger.textContent, "reference-model");
	assert.equal(action().disabled, false);
	await act(async () => trigger.click());
	const popup = document.querySelector(".model-status-popover");
	assert.ok(popup);
	assert.ok(popup.textContent?.includes("model.fixed"));
	assert.equal(document.activeElement === editor(), false);
});
