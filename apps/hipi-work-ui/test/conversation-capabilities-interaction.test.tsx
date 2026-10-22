// @vitest-environment jsdom
import assert from "node:assert/strict";
import {
	type AgentContext,
	type AppClient,
	type Conversation,
	type Method,
	type Params,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { permissionLabels } from "../src/features/agent-permissions/labels.ts";
import { PermissionSession } from "../src/features/agent-permissions/permission-session.ts";
import { ConversationCapabilities } from "../src/features/conversation-capabilities/conversation-capabilities.tsx";
import { ToolPackSession } from "../src/features/tool-packs/session.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

const queries = vi.hoisted(() => new Map<string, boolean>());
const projectFixture = vi.hoisted(() => ({
	available: false,
	failed: false,
	onlyBoundRoot: false,
	rootsFailed: false,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled: boolean }) => {
		queries.set(queryKey[0] ?? "", enabled);
		return {
			data:
				queryKey[0] === "agent-context-roots"
					? [
							{ rootId: "root", displayName: "Project files", writable: false },
							...(projectFixture.onlyBoundRoot
								? []
								: [{ rootId: "other", displayName: "Other files", writable: true }]),
						]
					: queryKey[0] === "tool-pack-model"
						? { model }
						: queryKey[0] === "projectFolder" && projectFixture.available
							? { status: "available", root: { rootId: "root" } }
							: undefined,
			isError:
				(queryKey[0] === "projectFolder" && projectFixture.failed) ||
				(queryKey[0] === "agent-context-roots" && projectFixture.rootsFailed),
			isFetching: false,
			isPending: false,
			refetch: async () => {},
		};
	},
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale }) }));
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
let locale = "en";
let contexts: AgentContext[] = [];
let contextReadFailed = false;
const calls: { method: Method; params: unknown }[] = [];
const client: AppClient = {
	call: async <M extends Method>(method: M, params: Params<M>) => {
		calls.push({ method, params });
		if (method === "listActiveAgentContexts") {
			if (contextReadFailed) throw new Error("READ_FAILED");
			return parseResult(method, contexts);
		}
		if (method === "listActiveToolPackBindings") return parseResult(method, []);
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
	projectFixture.available = false;
	projectFixture.failed = false;
	projectFixture.onlyBoundRoot = false;
	projectFixture.rootsFailed = false;
	locale = "en";
	contexts = [];
	contextReadFailed = false;
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

test.each([true, false])(
	"additional context never preselects the bound project or its whole folder (sole root: %s)",
	async (onlyBoundRoot) => {
		projectFixture.available = true;
		projectFixture.onlyBoundRoot = onlyBoundRoot;
		await drive();
		await openMenu();
		await click(find(".capability-context-trigger"));
		const consent = find<HTMLElement>(".context-consent-dialog");
		const folderPicker = find('[role="combobox"]', consent);
		assert.equal(folderPicker.textContent, permissionLabels("en")["permissions.context.root"]);
		assert.equal(consent.querySelector(".context-project-folder"), null);
		assert.ok(find("textarea", consent), "Path scope stays explicit rather than defaulting to the entire project");
		const authorize = [...consent.querySelectorAll("button")].find(
			(node) => node.textContent === permissionLabels("en")["permissions.context.authorize"],
		);
		assert.ok(authorize?.disabled);
		assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
		await act(async () => folderPicker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
			node.textContent?.includes(onlyBoundRoot ? "Project files" : "Other files"),
		);
		assert.ok(option);
		await click(option);
		const textarea = find<HTMLTextAreaElement>("textarea", consent);
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			assert.ok(setter);
			setter.call(textarea, "src");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		assert.equal(authorize.disabled, false);
		await click(authorize);
		const pending = owners().session.getPending();
		assert.ok(pending && pending.method === "authorizeAgentContext");
		assert.equal(pending.params.rootId, onlyBoundRoot ? "root" : "other");
		assert.deepEqual(pending.params.pathPrefixes, ["src"]);
		assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 1);
	},
);

test("stale project-folder data after a failed host read does not assert unshared project status", async () => {
	projectFixture.available = true;
	projectFixture.failed = true;
	await drive();
	await click(find(".capabilities-trigger"));
	assert.equal(document.querySelector(".project-context-notice"), null);
	assert.ok(find('button[aria-haspopup="dialog"]', find(".conversation-options-dialog")));
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});

test.each(["en", "zh"])("bound projects have no per-chat authorization notice in %s", async (language) => {
	locale = language;
	projectFixture.available = true;
	await drive();
	assert.equal(host.querySelector(".project-context-notice"), null);
	assert.equal(host.querySelector(".permission-attention")?.childElementCount, 0);
	const trigger = find(".permission-mode-trigger");
	assert.equal(trigger.hasAttribute("title"), false);
	assert.equal(trigger.hasAttribute("data-action-tooltip-trigger"), true);
	assert.equal(trigger.querySelectorAll("svg").length, 1, "Management retains its shield, not a fake mode chevron");
	await click(find(".capabilities-trigger"));
	const management = find<HTMLElement>(".conversation-options-dialog");
	assert.equal(management.querySelector(".project-context-notice"), null);
	assert.equal(management.textContent?.includes("Project files are not shared with this chat"), false);
	assert.equal(management.textContent?.includes("Allow project access"), false);
	assert.equal(management.textContent?.includes("尚未向此聊天共享项目文件"), false);
	assert.equal(management.textContent?.includes("允许访问项目"), false);
	assert.ok(management.textContent?.includes(permissionLabels(locale)["permissions.context.none"]));
	await click(find('button[aria-haspopup="dialog"]', management));
	assert.ok(find(".context-consent-dialog"));
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});

test("failed additional-folder reads remain visible without an authorization attempt", async () => {
	projectFixture.available = true;
	projectFixture.rootsFailed = true;
	await drive();
	await openMenu();
	await click(find(".capability-context-trigger"));
	const consent = find<HTMLElement>(".context-consent-dialog");
	assert.ok(
		[...consent.querySelectorAll('[role="alert"]')].some(
			(node) => node.textContent === permissionLabels("en")["permissions.action.failed"],
		),
	);
	assert.equal(find('[role="combobox"]', consent).disabled, true);
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});

test("explicit grant history stays reviewable without creating a bound-project authorization notice", async () => {
	projectFixture.available = true;
	const grant: AgentContext = {
		workspaceId: conversation.workspaceId,
		conversationId: conversation.conversationId,
		grantId: "grant",
		requestId: "grant-request",
		purpose: "live-files",
		rootId: "root",
		pathPrefixes: [""],
		model,
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1,
		status: "active",
		revision: 1,
	};
	// Contract values are checked by parseResult in the injected client, not inferred from assistant text.
	contexts = [grant];
	const { session } = await drive();
	await click(find(".capabilities-trigger"));
	assert.equal(document.querySelector(".project-context-notice"), null);
	assert.ok(
		[...find(".conversation-options-dialog").querySelectorAll("button")].some(
			(button) => button.textContent === permissionLabels("en")["permissions.context.revoke"] && !button.disabled,
		),
	);
	for (const changed of [
		{ ...grant, rootId: "other" },
		{ ...grant, model: { ...model, modelId: "different-model" } },
		{ ...grant, expiresAt: 1 },
	]) {
		contexts = [changed];
		await act(async () => session.refresh());
		assert.equal(document.querySelector(".project-context-notice"), null);
		assert.equal(host.querySelector(".project-context-notice"), null);
	}
	// Revoked grants disappear from the active endpoint; non-active values are contract errors.
	contexts = [];
	await act(async () => session.refresh());
	assert.equal(document.querySelector(".project-context-notice"), null);
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});

test("unverified permission reads and offline state never claim project files are unshared", async () => {
	projectFixture.available = true;
	contextReadFailed = true;
	await drive();
	assert.ok(host.textContent?.includes(permissionLabels("en")["permissions.action.failed"]));
	assert.equal(host.querySelector(".project-context-notice"), null);
	await click(find(".capabilities-trigger"));
	assert.equal(document.querySelector(".project-context-notice"), null);
	await closeDialog(".conversation-options-dialog");
	await drive(conversation, false);
	await click(find(".capabilities-trigger"));
	assert.equal(document.querySelector(".project-context-notice"), null);
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});

test("plus hover uses the shared tooltip and opening consent retires it through returned focus", async () => {
	await drive();
	const plus = find(".composer-add-trigger");
	assert.equal(plus.hasAttribute("title"), false);
	assert.equal(plus.querySelector("svg")?.getAttribute("width"), "16");
	await act(async () => {
		plus.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
	assert.equal(document.querySelector('[role="tooltip"]')?.textContent, "Add files and tools");
	assert.equal(plus.getAttribute("data-state"), "closed", "Tooltip state must not replace menu state");
	await act(async () => {
		plus.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
	});
	assert.ok(document.querySelector('[role="menu"]'));
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	await click(find(".capability-context-trigger"));
	assert.ok(document.querySelector(".context-consent-dialog"));
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	await closeDialog(".context-consent-dialog");
	assert.equal(document.activeElement, plus);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
	assert.equal(document.querySelector('[role="tooltip"]'), null, "Restored pointer focus is not a new hover");
	assert.equal(find(".composer-add-trigger"), plus);
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});
