import assert from "node:assert/strict";
import { type AppClient, type Conversation, type Method, type Params, parseResult } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog, DialogContent } from "../src/components/ui/dialog.tsx";
import { DropdownMenuContent, DropdownMenuItem } from "../src/components/ui/dropdown-menu.tsx";
import { Select } from "../src/components/ui/select.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { AgentPermissionManagement } from "../src/features/agent-permissions/agent-permissions.tsx";
import { ContextDialog } from "../src/features/agent-permissions/context-dialog.tsx";
import { permissionLabels } from "../src/features/agent-permissions/labels.ts";
import { ConversationCapabilities } from "../src/features/conversation-capabilities/conversation-capabilities.tsx";
import { ToolPackSession } from "../src/features/tool-packs/session.ts";
import { ToolPacksPanel } from "../src/features/tool-packs/tool-packs-panel.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	owners: new Map<string, Cell[]>(),
	current: [] as Cell[],
	name: "",
	cursor: 0,
	commits: [] as (() => void)[],
	queries: new Map<string, boolean>(),
}));
// Run the production callbacks and each permanent owner's hooks in an isolated
// lifecycle. Native acceptance still verifies React portals, focus traps and DOM clicks.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	function cell() {
		const owner = hooks.current;
		const index = hooks.cursor++;
		return { owner, index, previous: owner[index] };
	}
	const changed = (previous: React.DependencyList | undefined, next: React.DependencyList) =>
		!previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
	return {
		...actual,
		useState: <T,>(initial: T | (() => T)) => {
			const { owner, index, previous } = cell();
			const current = previous ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			owner[index] = current;
			return [
				current.value,
				(next: T | ((value: T) => T)) => {
					current.value = typeof next === "function" ? (next as (value: T) => T)(current.value as T) : next;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const { owner, index, previous } = cell();
			const current = previous ?? { value: { current: initial } };
			owner[index] = current;
			return current.value;
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const { owner, index, previous } = cell();
			if (!previous || changed(previous.deps, deps)) owner[index] = { value: create(), deps };
			return owner[index]?.value;
		},
		useId: () => `${hooks.name}-field-${hooks.cursor++}`,
		useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const { owner, index, previous } = cell();
			if (!previous || changed(previous.deps, deps))
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					owner[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled: boolean }) => {
		hooks.queries.set(queryKey[0] ?? "", enabled);
		return {
			data: queryKey[0] === "agent-context-roots" ? [{ rootId: "root", displayName: "Project files" }] : { model },
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
function run<T>(name: string, render: () => T) {
	const cells = hooks.owners.get(name) ?? [];
	hooks.owners.set(name, cells);
	hooks.current = cells;
	hooks.name = name;
	hooks.cursor = 0;
	return render();
}
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function element<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const matches = elements(node, type);
	assert.equal(matches.length, 1);
	const only = matches[0];
	assert.ok(only);
	return only;
}
function button(node: React.ReactNode, className: string) {
	const found = [...elements(node, Button), ...elements(node, "button")].find(
		(item) => item.props.className === className,
	);
	assert.ok(found, className);
	return found;
}
function click(
	target: React.ReactElement<React.ComponentProps<"button">>,
	trigger = { isConnected: true, focus: vi.fn() },
) {
	assert.ok(target.props.onClick);
	Reflect.apply(target.props.onClick, undefined, [{ currentTarget: trigger }]);
	return trigger;
}
function drive(current = conversation, connected = true, selectedModel: typeof model | null = model) {
	const owner = run("capabilities", () =>
		ConversationCapabilities({ conversation: current, connected, model: selectedModel ?? undefined }),
	);
	assert.equal(owner.type, AgentPermissionManagement);
	const permission = run("permissions", () => AgentPermissionManagement(owner.props));
	const context = element(permission, ContextDialog);
	const packs = element(permission, ToolPacksPanel);
	const controls = run("tools", () => ToolPacksPanel(packs.props));
	const consent = run("context", () => ContextDialog(context.props));
	for (const commit of hooks.commits.splice(0)) commit();
	const packSession = hooks.owners.get("tools")?.find((entry) => entry?.value instanceof ToolPackSession)?.value;
	assert.ok(packSession instanceof ToolPackSession);
	assert.equal(elements(controls, ContextDialog).length, 0, "Consent owner must not live inside the dismissible sheet");
	return {
		owner,
		context,
		packs,
		controls,
		consent,
		session: context.props.session,
		packSession,
		dialog: element(controls, Dialog),
	};
}
beforeEach(() => {
	hooks.owners.clear();
	hooks.commits = [];
	hooks.queries.clear();
	calls.length = 0;
	local = new LocalState();
	const events = new EventTarget();
	vi.stubGlobal("document", {
		visibilityState: "visible",
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	});
});
afterEach(() => {
	for (const owner of hooks.owners.values()) for (const entry of owner) entry?.cleanup?.();
	vi.unstubAllGlobals();
});
test("direct Tools opens the correct live section, preserves both owners and restores the actual triggering button", async () => {
	const initial = drive();
	assert.equal(initial.dialog.props.open, false);
	assert.equal(hooks.queries.get("agent-context-roots"), false);
	assert.equal(hooks.queries.get("tool-pack-model"), false);
	const trigger = { isConnected: true, focus: vi.fn() };
	const plus = button(initial.controls, "composer-add-trigger");
	assert.ok(plus.props.ref && typeof plus.props.ref === "object");
	plus.props.ref.current = trigger as unknown as HTMLButtonElement;
	click(button(initial.controls, "capability-tools-trigger"));
	const transfer = new Event("closeAutoFocus", { cancelable: true });
	element(initial.controls, DropdownMenuContent).props.onCloseAutoFocus?.(transfer);
	assert.equal(transfer.defaultPrevented, true, "The menu must not refocus behind the newly opening dialog");
	const opened = drive();
	assert.equal(opened.dialog.props.open, true);
	assert.equal(opened.owner.props.detailsOpen, false);
	assert.equal(opened.packs.props.active, true);
	assert.equal(opened.packs.props.conversation, conversation);
	assert.equal(opened.packs.props.workspaceId, conversation.workspaceId);
	assert.equal(opened.session, initial.session);
	assert.equal(opened.packSession, initial.packSession);
	assert.equal(hooks.queries.get("tool-pack-model"), true);
	assert.equal(
		element(opened.controls, DialogContent).props["data-section" as keyof React.ComponentProps<typeof DialogContent>],
		"tool-packs",
	);
	await vi.waitFor(() => assert.equal(opened.packSession.getSnapshot().loaded, true));
	opened.dialog.props.onOpenChange?.(false);
	const closed = drive();
	assert.equal(closed.packs.props.active, false);
	assert.equal(closed.session, initial.session);
	assert.equal(closed.packSession, initial.packSession);
	const event = new Event("closeAutoFocus", { cancelable: true });
	element(closed.controls, DialogContent).props.onCloseAutoFocus?.(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(trigger.focus.mock.calls.length, 1);
	assert.ok(
		calls.every(({ method }) => method.startsWith("list")),
		"Opening capabilities never authorizes anything",
	);
});
test("File context and management share one draft, one consent owner and the exact immutable pending command", async () => {
	const initial = drive();
	await vi.waitFor(() => assert.equal(initial.session.getSnapshot().loaded, true));
	const ready = drive();
	const direct = click(button(ready.controls, "capability-context-trigger"));
	const opened = drive();
	assert.equal(opened.context.props.open, true);
	assert.equal(opened.dialog.props.open, false);
	assert.equal(hooks.queries.get("agent-context-roots"), true);
	assert.deepEqual(opened.context.props.scope, {
		workspaceId: conversation.workspaceId,
		conversationId: conversation.conversationId,
	});
	assert.equal(opened.context.props.model, model);
	const root = elements(opened.consent, Select)[0];
	assert.ok(root?.props.onValueChange);
	root.props.onValueChange("root");
	const textarea = element(opened.consent, Textarea);
	assert.ok(textarea.props.onChange);
	Reflect.apply(textarea.props.onChange, undefined, [{ target: { value: "src\ndocs" } }]);
	opened.context.props.onOpenChange(false);
	opened.context.props.onCloseAutoFocus(new Event("closeAutoFocus", { cancelable: true }));
	assert.equal(direct.focus.mock.calls.length, 1);
	const closed = drive();
	assert.equal(element(closed.consent, Textarea).props.value, "src\ndocs");
	click(button(closed.controls, "capabilities-trigger permission-mode-trigger"));
	const management = drive();
	const managementContext = elements(management.controls, Button).find(
		(item) =>
			item.props["aria-controls"] === management.context.props.contentId &&
			item.props.className !== "capability-context-trigger",
	);
	assert.ok(managementContext);
	const managementTrigger = click(managementContext);
	const reopened = drive();
	assert.equal(reopened.session, initial.session);
	assert.equal(reopened.context.props.open, true);
	assert.equal(element(reopened.consent, Textarea).props.value, "src\ndocs");
	assert.equal(elements(reopened.consent, Select)[0]?.props.value, "root");
	reopened.context.props.onOpenChange(false);
	reopened.context.props.onCloseAutoFocus(new Event("closeAutoFocus", { cancelable: true }));
	assert.equal(managementTrigger.focus.mock.calls.length, 1);
	reopened.dialog.props.onOpenChange?.(false);
	const sheetClosed = drive();
	assert.equal(element(sheetClosed.consent, Textarea).props.value, "src\ndocs");
	click(button(sheetClosed.controls, "capability-context-trigger"));
	const finalConsent = drive();
	const authorize = element(finalConsent.consent, Button);
	assert.equal(authorize.props.disabled, false);
	click(authorize);
	await vi.waitFor(() => assert.equal(initial.session.getSnapshot().uncertain, true));
	await vi.waitFor(() => assert.equal(initial.session.getSnapshot().busy, false));
	const uncertain = drive();
	assert.equal(uncertain.context.props.open, true, "An unknown authorization outcome does not dismiss consent");
	assert.ok(
		elements(uncertain.consent, "p").some(
			(item) =>
				item.props.role === "alert" && item.props.children === permissionLabels("en")["permissions.action.unknown"],
		),
		"The open consent dialog exposes uncertainty instead of hiding the warning behind its overlay",
	);
	const pending = initial.session.getPending();
	assert.equal(pending?.method, "authorizeAgentContext");
	assert.ok(pending && pending.method === "authorizeAgentContext");
	assert.deepEqual(pending.params.pathPrefixes, ["src", "docs"]);
	assert.deepEqual(pending.params.model, model);
	assert.equal(pending.params.workspaceId, conversation.workspaceId);
	assert.equal(pending.params.conversationId, conversation.conversationId);
	finalConsent.context.props.onOpenChange(false);
	for (const open of [true, false, true, false]) {
		const current = drive();
		current.dialog.props.onOpenChange?.(open);
		assert.equal(current.session, initial.session);
		assert.deepEqual(current.session.getPending(), pending);
		assert.equal(element(current.consent, Textarea).props.value, "src\ndocs");
	}
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 1);
	assert.equal(local.hasUnsavedWork(), true);
});
test("direct file consent remains unavailable without a ready connection, model or unarchived conversation", async () => {
	const initial = drive();
	await vi.waitFor(() => assert.equal(initial.session.getSnapshot().loaded, true));
	assert.equal(button(drive().controls, "capability-context-trigger").props.disabled, false);
	for (const current of [
		drive(conversation, false),
		drive({ ...conversation, archivedAt: 2 }),
		drive(conversation, true, null),
	]) {
		assert.equal(button(current.controls, "capability-context-trigger").props.disabled, true);
		assert.equal(elements(current.controls, DropdownMenuItem)[0]?.props.disabled, true);
	}
	assert.equal(calls.filter(({ method }) => method === "authorizeAgentContext").length, 0);
});
