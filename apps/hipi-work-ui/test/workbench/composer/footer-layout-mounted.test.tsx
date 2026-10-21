// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type AppClient, type Method, type Params, parseResult, parseToolApproval } from "@hipi/work-runtime/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { permissionLabels } from "../../../src/features/agent-permissions/labels.ts";
import { PermissionSession } from "../../../src/features/agent-permissions/permission-session.ts";
import { ConversationPane } from "../../../src/features/workbench/conversation/pane.tsx";
import type { ConversationController } from "../../../src/features/workbench/conversation/use-conversation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

const conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Layout",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const selectedModel = { provider: "faux", modelId: "fixed-model" };
let modelName = "A long English model name";
let locale = "en";
let local = new LocalState();
let permissionFailed = false;
let pendingApproval = false;
const approval = parseToolApproval({
	workspaceId: conversation.workspaceId,
	conversationId: conversation.conversationId,
	approvalId: "approval",
	taskId: "task",
	callId: "call",
	submissionIds: ["submission"],
	receiptIds: ["receipt"],
	toolName: "hipi_files_save",
	model: selectedModel,
	rootId: "root",
	path: "example.ts",
	ifMatch: "a".repeat(64),
	text: "after",
	beforeText: "before",
	beforeTextTruncated: false,
	argumentsDigest: "a".repeat(64),
	contentDigest: "a".repeat(64),
	grantId: "grant",
	grantRevision: 1,
	expiresAt: 9000000000000,
	createdAt: 1,
	revision: 1,
	status: "pending",
});
const submit = vi.fn();
const cancel = vi.fn();
const manageModels = vi.fn();
const modelRefetch = vi.fn(async () => {});
const permissionActivation = vi.spyOn(PermissionSession.prototype, "activate");
const calls: Method[] = [];
const client: AppClient = {
	async call<M extends Method>(method: M, _params: Params<M>) {
		calls.push(method);
		if (method === "listActiveAgentContexts") {
			if (permissionFailed) throw new Error("READ_FAILED");
			return parseResult(method, []);
		}
		if (method === "listActiveToolPackBindings") return parseResult(method, []);
		if (method === "listPendingToolApprovals")
			return parseResult(method, { items: pendingApproval ? [approval] : [], nextCursor: null });
		if (method === "listToolPacks") return parseResult(method, { items: [], nextCursor: null });
		throw new Error(`Unexpected method: ${method}`);
	},
	async observe() {
		return { dispose: async () => {} };
	},
};
let state: ConversationController;
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale, t: (key: string) => key }) }));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useAppClient: () => client,
	useLocalState: () => local,
	useFiles: () => ({}),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		data: queryKey[0] === "models" ? { models: [{ ...selectedModel, name: modelName }], providers: [] } : undefined,
		isError: false,
		isPending: false,
		isFetching: false,
		refetch: async () => {},
	}),
}));
vi.mock("../../../src/features/workbench/conversation/use-conversation.ts", () => ({ useConversation: () => state }));
vi.mock("../../../src/features/workbench/conversation/history.tsx", () => ({ ConversationHistory: () => null }));
vi.mock("../../../src/features/workbench/conversation/receipt.tsx", () => ({
	ConversationReceipt: () => null,
	ReceiptRecovery: () => null,
}));
vi.mock("../../../src/features/tool-activities/activity-transcript.tsx", () => ({
	ActivityTranscriptProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../../src/features/tool-activities/tool-activities.tsx", () => ({
	ActivityHistoryAction: () => null,
	ActivityHistoryDialog: () => null,
}));

let root: Root;
let host: HTMLDivElement;
let rowWidth = 320;
let labelWidth = 180;
let compactWidth = 28;
const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
function width(element: Element) {
	if (element instanceof HTMLElement && element.hidden) return 0;
	if (element.classList.contains("composer-footer-trailing")) return rowWidth;
	if (element.classList.contains("composer-footer-actions")) return 36;
	if (element.classList.contains("composer-inline-control"))
		return element.querySelector("[data-compact=true]") ? compactWidth : labelWidth;
	return 0;
}
class ObservedResize {
	static active = new Set<ObservedResize>();
	targets = new Set<Element>();
	callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ObservedResize.active.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		ObservedResize.active.delete(this);
	}
	emit() {
		this.callback(
			[...this.targets].map((target) => ({
				target,
				contentRect: new DOMRect(0, 0, width(target), 28),
				borderBoxSize: [],
				contentBoxSize: [],
				devicePixelContentBoxSize: [],
			})),
			this,
		);
	}
}
const NativeMutationObserver = MutationObserver;
class ObservedMutation extends NativeMutationObserver {
	static owned = new Set<ObservedMutation>();
	observe(target: Node, options?: MutationObserverInit) {
		if (
			target === document.documentElement ||
			(target instanceof Element && target.classList.contains("composer-inline-control"))
		)
			ObservedMutation.owned.add(this);
		super.observe(target, options);
	}
	disconnect() {
		ObservedMutation.owned.delete(this);
		super.disconnect();
	}
}
function find<T extends Element = HTMLElement>(selector: string, within: ParentNode = host): T {
	const element = within.querySelector<T>(selector);
	assert.ok(element, selector);
	return element;
}
async function render(withSettings = true) {
	await act(async () =>
		root.render(
			<ConversationPane
				conversation={conversation}
				detailsOpen={false}
				onDetailsClose={() => {}}
				onOpenModelSettings={withSettings ? manageModels : undefined}
			/>,
		),
	);
}
async function resize(value: number) {
	rowWidth = value;
	await act(async () => {
		for (const observer of [...ObservedResize.active]) observer.emit();
	});
}
async function pointer(node: HTMLElement, type: string, relatedTarget: EventTarget | null = null) {
	await act(async () => {
		node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget }));
	});
}
async function tick(ms: number) {
	await act(async () => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", ObservedResize);
	vi.stubGlobal("MutationObserver", ObservedMutation);
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get() {
			return width(this);
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return width(this);
		},
	});
	rowWidth = 320;
	labelWidth = 180;
	compactWidth = 28;
	modelName = "A long English model name";
	locale = "en";
	permissionFailed = false;
	pendingApproval = false;
	local = new LocalState();
	calls.length = 0;
	permissionActivation.mockClear();
	submit.mockClear();
	cancel.mockClear();
	manageModels.mockClear();
	modelRefetch.mockClear();
	state = {
		workspaceId: conversation.workspaceId,
		draft: "Draft survives layout",
		setDraft: vi.fn(),
		submit,
		blocked: false,
		composing: { current: false },
		mutation: { isPending: false, isError: false },
		execution: { isPending: false, isError: false, mutate: cancel },
		model: {
			data: { model: selectedModel, credentialState: "configured", executionState: "ready" },
			isError: false,
			isFetching: false,
			refetch: modelRefetch,
		},
		storeMismatch: false,
		receipt: { isError: false },
		storageAvailable: true,
		observation: {
			connection: "connected",
			showConnectionNotice: false,
			snapshot: { ...conversation, messages: [], running: false },
		},
	} as unknown as ConversationController;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(ObservedResize.active.size, 0, "Every live size observer must disconnect");
	assert.equal(ObservedMutation.owned.size, 0, "Every inline/theme mutation observer must disconnect");
	host.remove();
	if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
	else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
	if (clientWidthDescriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
	else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
	document.documentElement.style.removeProperty("--font-ui-size");
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("actual pane separates input, leading capabilities and trailing model/send with one permission owner", async () => {
	await render();
	const grid = find(".composer-footer-grid");
	assert.deepEqual(
		[...grid.children].map((node) => node.className),
		["composer-footer-input", "composer-footer-leading", "composer-footer-trailing"],
	);
	assert.ok(find(".composer-footer-leading .composer-add-trigger"));
	assert.ok(find(".composer-footer-leading .permission-mode-trigger > span").textContent);
	assert.ok(find(".composer-footer-trailing .model-status-trigger"));
	assert.ok(find(".composer-footer-actions .composer-submit"));
	assert.equal(permissionActivation.mock.calls.length, 1);
	const editor = find('[role="textbox"]');
	await resize(150);
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "true");
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	await resize(50);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	assert.equal(find<HTMLSpanElement>(".permission-mode-trigger > span").hidden, false);
	await resize(320);
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "false");
	assert.equal(find('[role="textbox"]'), editor);
	assert.equal(permissionActivation.mock.calls.length, 1);
});

test("long translated labels and changed UI font widths invalidate cached expanded measurements", async () => {
	await render();
	await resize(150);
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "true");
	locale = "zh-CN";
	modelName = "一个很长的中文模型名称";
	labelWidth = 90;
	await render();
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "false");
	labelWidth = 240;
	await act(async () => document.documentElement.style.setProperty("--font-ui-size", "22px"));
	await resize(150);
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "true");
	await resize(300);
	assert.equal(find(".model-status-trigger").getAttribute("data-compact"), "false");
});

test("the sole model entry, focused trigger and open popup do not disappear at a narrow budget", async () => {
	await render(false);
	await resize(50);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	await resize(320);
	await render();
	const trigger = find<HTMLButtonElement>(".model-status-trigger");
	await act(async () => trigger.focus());
	await resize(50);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	await act(async () => trigger.click());
	assert.ok(document.querySelector(".model-status-popover"));
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	assert.equal(submit.mock.calls.length, 0);
	assert.equal(cancel.mock.calls.length, 0);
});

test("failed permission/model recovery stays outside width calculation and permission forms cannot submit a task", async () => {
	permissionFailed = true;
	state.model.isError = true;
	state.execution.isError = true;
	await render();
	await resize(50);
	assert.ok(find(".composer-attention .permission-attention [role=alert]"));
	assert.ok(find(".composer-attention .conversation-model-attention [role=alert]"));
	assert.equal(find(".composer-footer-grid").querySelector(".permission-attention"), null);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	const retry = find<HTMLButtonElement>(".composer-attention .conversation-model-attention button");
	assert.equal(retry.textContent, "model.retryRead");
	assert.equal(retry.disabled, false);
	await act(async () => retry.click());
	assert.equal(modelRefetch.mock.calls.length, 1);
	assert.equal(state.execution.isError, true, "Reading state does not acknowledge an uncertain command outcome");
	assert.equal(cancel.mock.calls.length, 0);
	const permission = find<HTMLButtonElement>(".permission-mode-trigger");
	await act(async () => permission.click());
	const dialog = find<HTMLElement>(".conversation-options-dialog", document);
	await act(async () => dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
	assert.equal(submit.mock.calls.length, 0);
	assert.equal(permissionActivation.mock.calls.length, 1);
	assert.ok(calls.every((method) => method.startsWith("list")));
});

test("healthy model status has no refresh and its compact tooltip retires when the popup owns interaction", async () => {
	await render();
	vi.useFakeTimers();
	await resize(150);
	const trigger = find<HTMLButtonElement>(".model-status-trigger");
	const editor = find('[role="textbox"]');
	assert.equal(trigger.getAttribute("data-compact"), "true");
	assert.equal(host.querySelector(".conversation-model-attention button"), null);
	await pointer(trigger, "pointermove");
	await tick(199);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	await tick(1);
	assert.equal(document.querySelector('[role="tooltip"]')?.textContent, "Model status");
	assert.equal(trigger.getAttribute("data-state"), "closed");
	await act(async () => trigger.click());
	const popup = find<HTMLElement>(".model-status-popover", document);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	assert.equal(trigger.getAttribute("data-state"), "open");
	assert.equal(trigger.getAttribute("data-slot"), "popover-trigger");
	assert.equal(popup.querySelector("button"), null, "Healthy status is read-only, not a refresh or model picker");
	await pointer(trigger, "pointerout", document.body);
	await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	await tick(1);
	assert.equal(document.querySelector(".model-status-popover"), null);
	assert.equal(document.activeElement, trigger);
	assert.equal(document.querySelector('[role="tooltip"]'), null, "Popup focus restoration is not a new hover");
	await act(async () => find<HTMLButtonElement>(".composer-submit").focus());
	await resize(50);
	await pointer(document.body, "pointermove");
	await tick(500);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	assert.equal(find('[role="textbox"]'), editor);
	assert.equal(find(".model-status-trigger"), trigger);
	assert.equal(modelRefetch.mock.calls.length, 0);
	assert.equal(submit.mock.calls.length, 0);
	assert.equal(cancel.mock.calls.length, 0);
});

test("hiding a model control cancels pending and mounted tooltips without reopening on resize", async () => {
	locale = "zh-CN";
	await render();
	vi.useFakeTimers();
	const trigger = find<HTMLButtonElement>(".model-status-trigger");
	await pointer(trigger, "pointermove");
	await tick(100);
	await resize(50);
	await resize(320);
	await tick(200);
	assert.equal(document.querySelector('[role="tooltip"]'), null, "The pre-resize delay must not reopen a hint");
	await pointer(trigger, "pointerout", document.body);
	await pointer(trigger, "pointermove");
	await tick(200);
	assert.equal(document.querySelector('[role="tooltip"]')?.textContent, "模型状态");
	await resize(50);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	await pointer(document.body, "pointermove");
	await resize(320);
	await tick(500);
	assert.equal(document.querySelector('[role="tooltip"]'), null);
	assert.equal(find(".model-status-trigger"), trigger);
	assert.equal(modelRefetch.mock.calls.length, 0);
	assert.equal(submit.mock.calls.length, 0);
});

test("closing a narrow model popup restores its trigger before later blur releases the width reservation", async () => {
	await render();
	const trigger = find<HTMLButtonElement>(".model-status-trigger");
	await act(async () => trigger.click());
	await resize(50);
	const popup = find<HTMLElement>(".model-status-popover", document);
	await act(async () =>
		popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
	);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	assert.equal(document.querySelector(".model-status-popover"), null);
	assert.equal(document.activeElement, trigger);
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	await act(async () => find<HTMLButtonElement>(".composer-submit").focus());
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
});

test("layout updates preserve IME and the editor submission owner", async () => {
	await render();
	const editor = find('[role="textbox"]');
	await act(async () => editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
	await resize(100);
	await act(async () =>
		editor.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
		),
	);
	assert.equal(submit.mock.calls.length, 0);
	await act(async () => editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
	await act(async () => find<HTMLButtonElement>(".composer-submit").click());
	assert.equal(submit.mock.calls.length, 1);
	assert.equal(find('[role="textbox"]'), editor);
});

test("transient widths wait for a stable compact measurement and repeated resize does not accumulate observers", async () => {
	await render();
	const trigger = find(".model-status-trigger");
	await act(async () => trigger.setAttribute("data-inline-collapse-transient-width", ""));
	await resize(50);
	assert.equal(trigger.getAttribute("data-compact"), "true");
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, false);
	await act(async () => trigger.removeAttribute("data-inline-collapse-transient-width"));
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	const active = ObservedResize.active.size;
	const mutations = ObservedMutation.owned.size;
	for (let cycle = 0; cycle < 5; cycle++) {
		await resize(320);
		await resize(50);
	}
	assert.equal(ObservedResize.active.size, active);
	assert.equal(ObservedMutation.owned.size, mutations);
});

test("pending approval and an actual unknown authorization outcome remain visible when the model control is hidden", async () => {
	pendingApproval = true;
	await render();
	await resize(50);
	const attention = find(".composer-attention .permission-attention");
	assert.ok(attention.textContent?.includes(permissionLabels("en")["permissions.status.pending"]));
	const session = permissionActivation.mock.contexts[0];
	assert.ok(session instanceof PermissionSession);
	await act(async () =>
		session.authorize({
			workspaceId: conversation.workspaceId,
			conversationId: conversation.conversationId,
			requestId: "authorization",
			rootId: "root",
			pathPrefixes: ["src"],
			model: selectedModel,
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		}),
	);
	assert.equal(session.getSnapshot().uncertain, true);
	assert.ok(attention.textContent?.includes(permissionLabels("en")["permissions.action.unknown"]));
	assert.equal(find<HTMLDivElement>(".composer-inline-control").hidden, true);
	assert.equal(permissionActivation.mock.calls.length, 1);
	assert.equal(calls.filter((method) => method === "authorizeAgentContext").length, 1);
	assert.equal(submit.mock.calls.length, 0);
});
