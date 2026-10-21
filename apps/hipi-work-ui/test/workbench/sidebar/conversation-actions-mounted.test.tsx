// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Conversation, ConversationPresentation } from "@hipi/work-runtime/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { ConversationActions } from "../../../src/features/workbench/catalog/controls.tsx";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { presentationKey } from "../../../src/features/workbench/sidebar/pin-conversation.tsx";
import { PresentationSession } from "../../../src/features/workbench/sidebar/presentation-session.ts";

const conversation: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "A chat",
	revision: 3,
	createdAt: 1,
	archivedAt: null,
};
let cache: QueryClient;
let client: AppClient;
let catalog: CatalogSession;
let presentation: PresentationSession;
let root: Root;
let host: HTMLDivElement;
let pin: ConversationPresentation;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	pin = {
		workspaceId: conversation.workspaceId,
		conversationId: conversation.conversationId,
		pinned: false,
		revision: 2,
	};
	client = { call: vi.fn(async () => pin) as AppClient["call"], observe: vi.fn() };
	cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	cache.setQueryData(presentationKey(conversation), pin);
	const local = new LocalState();
	catalog = new CatalogSession(client, local);
	presentation = new PresentationSession(client, local);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	cache.clear();
	catalog.dispose();
	presentation.dispose();
	host.remove();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(item = conversation, inlineActions = true) {
	await act(async () =>
		root.render(
			<AppClientProvider client={client}>
				<QueryClientProvider client={cache}>
					<PreferencesProvider>
						<ConversationActions
							conversation={item}
							session={catalog}
							presentation={presentation}
							guard={(action) => action()}
							inlineActions={inlineActions}
						/>
					</PreferencesProvider>
				</QueryClientProvider>
			</AppClientProvider>,
		),
	);
}
async function openMenu() {
	const button = host.querySelector<HTMLButtonElement>(".conversation-actions-trigger");
	assert.ok(button);
	await act(async () =>
		button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("inline controls expose More then Pin with accessible labels, without an extra archive button", async () => {
	await render();
	const buttons = [...host.querySelectorAll<HTMLButtonElement>(".conversation-hover-actions button")];
	assert.equal(buttons.length, 2);
	assert.ok(buttons[0]);
	assert.ok(buttons[1]);
	assert.ok(buttons[0].classList.contains("conversation-actions-trigger"));
	assert.equal(buttons[0].getAttribute("aria-label"), "会话操作: A chat");
	assert.equal(buttons[1].dataset.action, "pin-conversation-direct");
	assert.equal(buttons[1].getAttribute("aria-label"), "固定会话");
	assert.equal(buttons[0].querySelector("svg")?.getAttribute("data-sidebar-icon"), "more");
	assert.equal(buttons[1].querySelector("svg")?.getAttribute("fill"), "none");
	assert.equal(host.querySelector("[data-action='archive-conversation-direct']"), null);
});

test("pinned quick control uses a filled public pin and retains Unpin semantics and exact revision", async () => {
	pin = { ...pin, pinned: true };
	cache.setQueryData(presentationKey(conversation), pin);
	const execute = vi.spyOn(presentation, "execute").mockResolvedValue();
	await render();
	const button = host.querySelector<HTMLButtonElement>("[data-action='pin-conversation-direct']");
	assert.ok(button);
	assert.equal(button.getAttribute("aria-label"), "取消固定会话");
	const svg = button.querySelector("svg");
	assert.equal(svg?.getAttribute("data-sidebar-icon"), "pinned");
	assert.equal(svg?.getAttribute("fill"), "currentColor");
	// Public Lucide Pin has a zero-area open stem and a closed head. Filling
	// cannot create a diagonal polygon across the stem or a PinOff slash.
	const paths = [...button.querySelectorAll("path")].map((path) => path.getAttribute("d"));
	assert.equal(paths[0], "M12 17v5");
	assert.match(paths[1] ?? "", /z$/i);
	await act(async () => button.click());
	assert.equal(execute.mock.calls.length, 1);
	assert.ok(execute.mock.calls[0]);
	assert.equal(execute.mock.calls[0][0].pinned, false);
	assert.equal(execute.mock.calls[0][0].expectedPresentationRevision, 2);
});

test.each([null, 10])(
	"archive state %s retains its working menu command without direct archive or restore",
	async (archivedAt) => {
		const execute = vi.spyOn(catalog, "execute").mockResolvedValue();
		await render({ ...conversation, archivedAt });
		assert.equal(host.querySelectorAll(".conversation-hover-actions button").length, archivedAt === null ? 2 : 1);
		await openMenu();
		const label = archivedAt === null ? "归档会话" : "恢复会话";
		const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
			(element) => element.textContent === label,
		);
		assert.ok(item);
		await act(async () => item.click());
		assert.equal(execute.mock.calls.length, 1);
		assert.ok(execute.mock.calls[0]);
		assert.equal(execute.mock.calls[0][0].method, archivedAt === null ? "archiveConversation" : "restoreConversation");
		assert.equal(execute.mock.calls[0][0].params.expectedRevision, conversation.revision);
	},
);

test("standalone controls retain only the menu trigger", async () => {
	await render(conversation, false);
	assert.equal(host.querySelectorAll("button").length, 1);
	assert.equal(host.querySelector("[data-action='pin-conversation-direct']"), null);
});

test("active conversation menu orders supported actions without a duplicate preview header", async () => {
	await render();
	await openMenu();
	const menu = document.querySelector<HTMLElement>("[role='menu']");
	assert.ok(menu);
	const entries = [...menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='separator']")];
	assert.deepEqual(
		entries.map((entry) => (entry.getAttribute("role") === "separator" ? "separator" : entry.textContent)),
		["重命名会话", "固定会话", "separator", "归档会话"],
	);
	assert.equal(menu.querySelector(".sidebar-menu-preview"), null);
});

test("an unresolved presentation operation disables quick pin and menu archive without disabling rename", async () => {
	const snapshot = presentation.getSnapshot();
	vi.spyOn(presentation, "getSnapshot").mockReturnValue({ ...snapshot, busy: true });
	await render();
	const pinButton = host.querySelector<HTMLButtonElement>("[data-action='pin-conversation-direct']");
	assert.ok(pinButton?.disabled);
	await openMenu();
	const items = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
	const archive = items.find((item) => item.textContent === "归档会话");
	const rename = items.find((item) => item.textContent === "重命名会话");
	assert.ok(archive);
	assert.ok(rename);
	assert.equal(archive.getAttribute("aria-disabled"), "true");
	assert.notEqual(rename.getAttribute("aria-disabled"), "true");
});
