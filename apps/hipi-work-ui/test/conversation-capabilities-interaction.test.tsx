// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Conversation, type Method, type Params, parseResult } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { permissionLabels } from "../src/features/agent-permissions/labels.ts";
import { PermissionSession } from "../src/features/agent-permissions/permission-session.ts";
import { ConversationCapabilities } from "../src/features/conversation-capabilities/conversation-capabilities.tsx";
import { ToolPackSession } from "../src/features/tool-packs/session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

const queries = vi.hoisted(() => new Map<string, boolean>());
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled: boolean }) => {
		queries.set(queryKey[0] ?? "", enabled);
		return {
			data:
				queryKey[0] === "agent-context-roots"
					? [
							{ rootId: "root", displayName: "Project files" },
							{ rootId: "other", displayName: "Other files" },
						]
					: queryKey[0] === "tool-pack-model"
						? { model }
						: undefined,
			isError: false,
			isFetching: false,
			isPending: false,
			refetch: async () => {},
		};
	},
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => client,
	useLocalState: () => local,
	useFiles: () => ({}),
}));
const conversation: Conversation = {
	workspaceId: "current-workspace",
	conversationId: "current-conversation",
	title: "Current task",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const model = { provider: "faux", modelId: "fixed-model" };
let local = new LocalState();
const calls: { method: Method; params: unknown }[] = [];
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		calls.push({ method, params });
		if (method === "listActiveAgentContexts" || method === "listActiveToolPackBindings") return parseResult(method, []);
		if (method === "listPendingToolApprovals" || method === "listToolPacks")
			return parseResult(method, { items: [], nextCursor: null });
		if (method === "getAgentCommandResult") return parseResult(method, null);
		throw new Error("LOST_REPLY");
	},
	observe: async () => ({ dispose: async () => {} }),
};
let root: Root;
let host: HTMLDivElement;
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
// Observe real owners without replacing their constructors, hooks, or lifecycle.
const permissionActivation = vi.spyOn(PermissionSession.prototype, "activate");
const packOwnership = vi.spyOn(ToolPackSession.prototype, "setArchived");
function owners() {
	const session = permissionActivation.mock.contexts[0];
	const packSession = packOwnership.mock.contexts[0];
	assert.ok(session instanceof PermissionSession);
	assert.ok(packSession instanceof ToolPackSession);
	assert.equal(permissionActivation.mock.calls.length, 1);
	assert.equal(new Set(packOwnership.mock.contexts).size, 1);
	return { session, packSession };
}
function find<T extends Element = HTMLButtonElement>(selector: string, within: ParentNode = document): T {
	const node = within.querySelector<T>(selector);
	assert.ok(node, selector);
	return node;
}
async function click(node: HTMLElement) {
	await act(async () => node.click());
}
async function openMenu() {
	const plus = find(".composer-add-trigger");
	await act(async () => {
		plus.focus();
		plus.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	return plus;
}
async function closeDialog(selector: string) {
	await click(find(`${selector} [data-slot="dialog-close"]`));
	// Radix restores focus after its unmount cleanup task.
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	assert.equal(document.querySelector(selector), null);
}
async function drive(current = conversation, connected = true, selectedModel: typeof model | null = model) {
	await act(async () =>
		root.render(
			<ConversationCapabilities conversation={current} connected={connected} model={selectedModel ?? undefined} />,
		),
	);
	return owners();
}
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
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
	queries.clear();
	permissionActivation.mockClear();
	packOwnership.mockClear();
	calls.length = 0;
	local = new LocalState();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
	else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	vi.unstubAllGlobals();
});
test("direct Tools opens the correct live section, preserves both owners and restores the actual triggering button", async () => {
	const initial = await drive();
	assert.equal(document.querySelector('[role="dialog"]'), null);
	assert.equal(queries.get("agent-context-roots"), false);
	assert.equal(queries.get("tool-pack-model"), false);
	const plus = await openMenu();
	await click(find(".capability-tools-trigger"));
	const dialog = find<HTMLElement>(".conversation-options-dialog");
	assert.equal(dialog.dataset.section, "tool-packs");
	assert.ok(dialog.contains(document.activeElement), "Menu cleanup must not refocus behind the newly opened dialog");
	assert.equal(find(".capabilities-trigger").getAttribute("aria-expanded"), "false");
	assert.equal(document.querySelector(".context-consent-dialog"), null);
	assert.deepEqual(owners(), initial);
	assert.equal(queries.get("tool-pack-model"), true);
	assert.equal(initial.packSession.getSnapshot().loaded, true);
	assert.ok(
		calls.some(
			({ method, params }) =>
				method === "listActiveToolPackBindings" && JSON.stringify(params).includes(conversation.conversationId),
		),
	);
	assert.ok(
		calls.some(
			({ method, params }) => method === "listToolPacks" && JSON.stringify(params).includes(conversation.workspaceId),
		),
	);
	await closeDialog(".conversation-options-dialog");
	assert.equal(queries.get("tool-pack-model"), false);
	assert.deepEqual(owners(), initial);
	assert.equal(document.activeElement, plus);
	assert.ok(
		calls.every(({ method }) => method.startsWith("list")),
		"Opening capabilities never authorizes anything",
	);
});
test("File context and management share one draft, one consent owner and the exact immutable pending command", async () => {
	const initial = await drive();
	assert.equal(initial.session.getSnapshot().loaded, true);
	const plus = await openMenu();
	await click(find(".capability-context-trigger"));
	let consent = find<HTMLElement>(".context-consent-dialog");
	assert.equal(document.querySelector(".conversation-options-dialog"), null);
	assert.equal(queries.get("agent-context-roots"), true);
	assert.ok(consent.textContent?.includes(`${model.provider} / ${model.modelId}`));
	await act(async () =>
		find('[role="combobox"]', consent).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
	);
	const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
		node.textContent?.includes("Project files"),
	);
	assert.ok(option);
	await click(option);
	const textarea = find<HTMLTextAreaElement>("textarea", consent);
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		assert.ok(setter);
		setter.call(textarea, "src\ndocs");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await closeDialog(".context-consent-dialog");
	assert.equal(document.activeElement, plus, "Detached menu items return focus to the persistent add trigger");
	await click(find(".capabilities-trigger"));
	const management = find<HTMLElement>(".conversation-options-dialog");
	const managementTrigger = find('button[aria-haspopup="dialog"]', management);
	await click(managementTrigger);
	consent = find<HTMLElement>(".context-consent-dialog");
	assert.equal(document.querySelectorAll(".context-consent-dialog").length, 1);
	assert.equal(management.contains(consent), false, "Consent must not live inside the dismissible sheet");
	assert.deepEqual(owners(), initial);
	assert.equal(find<HTMLTextAreaElement>("textarea", consent).value, "src\ndocs");
	assert.ok(find('[role="combobox"]', consent).textContent?.includes("Project files"));
	await closeDialog(".context-consent-dialog");
	assert.equal(document.activeElement, managementTrigger);
	await closeDialog(".conversation-options-dialog");
	await openMenu();
	await click(find(".capability-context-trigger"));
	consent = find<HTMLElement>(".context-consent-dialog");
	assert.equal(find<HTMLTextAreaElement>("textarea", consent).value, "src\ndocs");
	const authorize = [...consent.querySelectorAll("button")].find(
		(node) => node.textContent === permissionLabels("en")["permissions.context.authorize"],
	);
	assert.ok(authorize);
	assert.equal(authorize.disabled, false);
	await click(authorize);
	assert.equal(initial.session.getSnapshot().uncertain, true);
	assert.equal(initial.session.getSnapshot().busy, false);
	assert.equal(document.querySelector(".context-consent-dialog"), consent, "Unknown outcomes do not dismiss consent");
	assert.ok(
		[...consent.querySelectorAll('[role="alert"]')].some(
			(node) => node.textContent === permissionLabels("en")["permissions.action.unknown"],
		),
	);
	const pending = initial.session.getPending();
	assert.ok(pending && pending.method === "authorizeAgentContext");
	const original = JSON.stringify(pending);
	assert.deepEqual(pending.params.pathPrefixes, ["src", "docs"]);
	assert.deepEqual(pending.params.model, model);
	assert.equal(pending.params.rootId, "root");
	assert.equal(pending.params.workspaceId, conversation.workspaceId);
	assert.equal(pending.params.conversationId, conversation.conversationId);
	await closeDialog(".context-consent-dialog");
	for (let cycle = 0; cycle < 2; cycle++) {
		await click(find(".capabilities-trigger"));
		assert.deepEqual(owners(), initial);
		assert.deepEqual(initial.session.getPending(), pending);
		assert.equal(JSON.stringify(initial.session.getPending()), original);
		await closeDialog(".conversation-options-dialog");
		assert.deepEqual(owners(), initial);
		assert.deepEqual(initial.session.getPending(), pending);
		assert.equal(JSON.stringify(initial.session.getPending()), original);
	}
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 1);
	assert.equal(local.hasUnsavedWork(), true);
});
test("direct file consent remains unavailable without a ready connection, model or unarchived conversation", async () => {
	await drive();
	await openMenu();
	assert.equal(find(".capability-context-trigger").disabled, false);
	for (const [current, connected, selectedModel] of [
		[conversation, false, model],
		[{ ...conversation, archivedAt: 2 }, true, model],
		[conversation, true, null],
	] as const) {
		await drive(current, connected, selectedModel);
		const trigger = find(".capability-context-trigger");
		assert.equal(trigger.disabled, true);
		assert.equal(trigger.getAttribute("aria-disabled"), "true");
		await click(trigger);
		assert.equal(document.querySelector(".context-consent-dialog"), null);
	}
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});
