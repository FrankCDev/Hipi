import assert from "node:assert/strict";
import type { ModelReference } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../../../src/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "../../../src/components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent } from "../../../src/components/ui/popover.tsx";
import { ComposerEditor } from "../../../src/features/workbench/composer/editor.tsx";
import { PreparedTaskEntry } from "../../../src/features/workbench/composer/prepared-entry.tsx";
import {
	ConversationModelAttention,
	ConversationModelControls,
} from "../../../src/features/workbench/conversation/model.tsx";
import type { ConversationController } from "../../../src/features/workbench/conversation/use-conversation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

const hooks = vi.hoisted(() => ({
	cells: [] as unknown[],
	effects: new Map<number, { deps: React.DependencyList; cleanup?: () => void }>(),
	commits: [] as (() => void)[],
	cursor: 0,
	changed: false,
}));
// Production handlers and synchronous submission fence; DOM sizing/focus stay native acceptance gates.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useLayoutEffect: () => {},
		useMemo: <T,>(factory: () => T) => factory(),
		useId: () => `input-${hooks.cursor++}`,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells))
				hooks.cells[index] = typeof initial === "function" ? (initial as () => T)() : initial;
			return [
				hooks.cells[index],
				(next: React.SetStateAction<T>) => {
					const value = typeof next === "function" ? (next as (current: T) => T)(hooks.cells[index] as T) : next;
					if (!Object.is(value, hooks.cells[index])) hooks.changed = true;
					hooks.cells[index] = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
			return hooks.cells[index];
		},
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const prior = hooks.effects.get(index);
			if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => !Object.is(value, prior.deps[i])))
				hooks.commits.push(() => {
					prior?.cleanup?.();
					const cleanup = effect();
					hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
				});
		},
	};
});
// This handler suite has no mounted DOM; actual adaptive measurement has its own mounted suite.
vi.mock("../../../src/features/workbench/composer/footer.tsx", () => ({ useComposerFooterWidth: () => null }));
vi.mock("../../../src/features/workbench/composer/use-inline-collapse.ts", () => ({
	useInlineCollapse: () => ({ model: { hideLabel: false, hideControl: false } }),
}));
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useLocalState: () => local,
	useAppClient: () => activeClient,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => {
		assert.deepEqual(queryKey, ["models"], "The composer does not read or authorize project context");
		return {
			data: {
				models,
				providers: [{ provider: "faux", name: "Faux", credentialState }],
			},
			isPending: false,
			isError: catalogFailed,
			isFetching: catalogFetching,
			refetch,
		};
	},
}));
let local = new LocalState();
let credentialState = "configured";
let catalogFailed = false;
let catalogFetching = false;
let models = [{ provider: "faux", modelId: "one", name: "One" }];
let draft = "";
const runtimeCall = vi.fn();
let activeClient = { call: runtimeCall };
const sent = vi.fn(async (_text: string, _model: ModelReference) => {});
const manageModels = vi.fn();
const refetch = vi.fn();
function find<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => find(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = find(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function only<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = find(node, type);
	assert.equal(found.length, 1);
	return found[0] as React.ReactElement<React.ComponentProps<C>>;
}
function render(extra: Partial<React.ComponentProps<typeof PreparedTaskEntry>> = {}) {
	for (let attempt = 0; attempt < 5; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const result = PreparedTaskEntry({
			disabled: false,
			busy: false,
			draft,
			onDraftChange: (value) => {
				draft = value;
				local.write("task-draft.project", value);
			},
			onSend: sent,
			onManageModels: manageModels,
			...extra,
		});
		for (const commit of hooks.commits.splice(0)) commit();
		if (!hooks.changed) return result;
	}
	throw new Error("Prepared composer effects did not settle");
}
function change(value: string) {
	const handler = only(render(), ComposerEditor).props.onChange;
	assert.ok(handler);
	Reflect.apply(handler, undefined, [value]);
}
function submit(node = render()) {
	const handler = only(node, "form").props.onSubmit;
	assert.ok(handler);
	Reflect.apply(handler, undefined, [{ preventDefault() {} }]);
}
beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	hooks.effects.clear();
	hooks.commits = [];
	local = new LocalState();
	activeClient = { call: runtimeCall };
	draft = "";
	credentialState = "configured";
	catalogFailed = false;
	catalogFetching = false;
	models = [{ provider: "faux", modelId: "one", name: "One" }];

	sent.mockReset();
	sent.mockResolvedValue(undefined);
	runtimeCall.mockClear();
	manageModels.mockClear();
	refetch.mockClear();
});
afterEach(() => {
	for (const effect of hooks.effects.values()) effect.cleanup?.();
	vi.useRealTimers();
});
test("opening and editing new chat never creates an object or sends", () => {
	render();
	change("A goal\nwith constraints");
	assert.equal(only(render(), ComposerEditor).props.value, "A goal\nwith constraints");
	assert.equal(local.read("task-draft.project"), "A goal\nwith constraints");
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(find(render(), "input").length, 0, "No name-first form");
});
test("one explicit Send captures prompt and visible model once, without a Create confirmation", async () => {
	change("Keep exact text\nincluding details.");
	let finish: (() => void) | undefined;
	sent.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const node = render();
	submit(node);
	submit(node);
	assert.deepEqual(sent.mock.calls, [["Keep exact text\nincluding details.", { provider: "faux", modelId: "one" }]]);
	assert.equal(draft, "Keep exact text\nincluding details.", "Only durable owner may reconcile input");
	assert.ok(finish);
	finish();
	await Promise.resolve();
});
test("shared editor delegates explicit submit to the same guarded owner", () => {
	change("Hello");
	only(render(), ComposerEditor).props.onSubmit();
	assert.equal(sent.mock.calls.length, 1);
});
test("missing credentials, failed model read, busy and pending recovery preserve text without dispatch", () => {
	change("Keep me");
	credentialState = "missing";
	submit();
	credentialState = "configured";
	catalogFailed = true;
	submit();
	catalogFailed = false;
	submit(render({ busy: true }));
	submit(render({ disabled: true }));
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(draft, "Keep me");
});
test("model setup navigation preserves input and never submits on return", () => {
	change("My detailed goal");
	const node = render();
	const action = find(node, DropdownMenuItem).find((item) => item.props.className === "new-chat-manage-models");
	assert.ok(action?.props.onSelect);
	Reflect.apply(action.props.onSelect, undefined, [new Event("select")]);
	assert.equal(manageModels.mock.calls.length, 1);
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(only(render(), ComposerEditor).props.value, "My detailed goal");
	const preventDefault = vi.fn();
	only(node, DropdownMenuContent).props.onCloseAutoFocus?.({ preventDefault } as Event);
	assert.equal(preventDefault.mock.calls.length, 1, "Menu closure must not steal focus from model settings");
});

test("model choices use a controlled radio menu and selection changes only the next Send preference", () => {
	models.push({ provider: "faux", modelId: "two", name: "Two" });
	change("Keep the prompt");
	const node = render();
	const group = only(node, DropdownMenuRadioGroup);
	assert.equal(group.props.value, '["faux","one"]');
	assert.deepEqual(
		find(node, DropdownMenuRadioItem).map((item) => [item.props.value, item.props.textValue]),
		[
			['["faux","one"]', "One"],
			['["faux","two"]', "Two"],
		],
	);
	group.props.onValueChange?.('["faux","two"]');
	assert.equal(only(render(), DropdownMenuRadioGroup).props.value, '["faux","two"]');
	assert.equal(local.read("new-chat-model"), '["faux","two"]');
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(draft, "Keep the prompt");
	submit();
	assert.deepEqual(sent.mock.calls, [["Keep the prompt", { provider: "faux", modelId: "two" }]]);
});

test("unknown or stale model values cannot redirect Send and catalog errors block selection", () => {
	change("Keep me");
	only(render(), DropdownMenuRadioGroup).props.onValueChange?.('["other","unlisted"]');
	assert.equal(local.read("new-chat-model"), null);
	models.push({ provider: "faux", modelId: "two", name: "Two" });
	only(render(), DropdownMenuRadioGroup).props.onValueChange?.('["faux","two"]');
	models = models.filter((model) => model.modelId !== "two");
	assert.equal(only(render(), DropdownMenuRadioGroup).props.value, "");
	submit();
	assert.equal(sent.mock.calls.length, 0, "A removed choice must not fall back to another provider/model");
	catalogFailed = true;
	const node = render();
	assert.ok(find(node, DropdownMenuRadioItem).every((item) => item.props.disabled));
	only(node, DropdownMenuRadioGroup).props.onValueChange?.('["faux","one"]');
	assert.equal(local.read("new-chat-model"), '["faux","two"]');
});

test("healthy and successfully empty model catalogs have no manual refresh action", () => {
	for (const entries of [models, []]) {
		models = entries;
		const node = render();
		assert.deepEqual(
			find(node, DropdownMenuItem).map((item) => item.props.className),
			["new-chat-manage-models"],
		);
	}
	assert.equal(refetch.mock.calls.length, 0);
});

test("failed model read retry retains the open menu, draft and ordinary focus restoration", () => {
	change("Keep this model question");
	catalogFailed = true;
	only(render(), DropdownMenu).props.onOpenChange?.(true);
	const node = render();
	const retry = find(node, DropdownMenuItem).find((item) => item.props.className === "new-chat-model-retry");
	const preventDefault = vi.fn();
	assert.ok(retry?.props.onSelect);
	assert.equal(retry.props.disabled, false);
	Reflect.apply(retry.props.onSelect, undefined, [{ preventDefault }]);
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.equal(refetch.mock.calls.length, 1);
	assert.equal(only(render(), DropdownMenu).props.open, true);
	assert.equal(only(render(), ComposerEditor).props.value, "Keep this model question");
	assert.equal(local.read("new-chat-model"), null);
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
	preventDefault.mockClear();
	only(node, DropdownMenuContent).props.onCloseAutoFocus?.({ preventDefault } as Event);
	assert.equal(preventDefault.mock.calls.length, 0);
});

test.each(["disabled", "busy", "fetching", "recovered", "sending"] as const)(
	"model catalog retry rejects stale callbacks after %s changes without dispatch",
	async (condition) => {
		change("Keep me");
		if (condition === "sending") {
			sent.mockImplementationOnce(() => new Promise(() => {}));
			submit();
		}
		catalogFailed = true;
		const retry = find(render(), DropdownMenuItem).find((item) => item.props.className === "new-chat-model-retry");
		assert.ok(retry?.props.onSelect);
		if (condition === "fetching") catalogFetching = true;
		if (condition === "recovered") catalogFailed = false;
		const node = render({ disabled: condition === "disabled", busy: condition === "busy" });
		const current = find(node, DropdownMenuItem).find((item) => item.props.className === "new-chat-model-retry");
		if (condition === "recovered") assert.equal(current, undefined);
		else if (condition !== "sending") assert.equal(current?.props.disabled, true);
		Reflect.apply(retry.props.onSelect, undefined, [{ preventDefault() {} }]);
		assert.equal(refetch.mock.calls.length, 0);
		assert.equal(sent.mock.calls.length, condition === "sending" ? 1 : 0);
		assert.equal(runtimeCall.mock.calls.length, 0);
		assert.equal(draft, "Keep me");
	},
);

function renderExistingModel() {
	hooks.cursor = 0;
	// Only the model presentation's dependencies are populated; mutation behavior
	// remains independently covered by useConversation and native execution suites.
	const controller = {
		workspaceId: "workspace",
		model: {
			data: {
				model: { provider: "faux", modelId: "one" },
				credentialState,
				executionState: "ready",
			},
			isPending: false,
			isError: false,
			isFetching: false,
			refetch,
		},
		execution: { isPending: false, isError: false, mutate: runtimeCall },
	} as ConversationController;
	return ConversationModelControls({ controller, onOpenModelSettings: manageModels });
}

test("an existing conversation opens missing-credential settings without model switching or execution", () => {
	credentialState = "missing";
	const node = renderExistingModel();
	assert.equal(find(node, DropdownMenuRadioGroup).length, 0, "Existing models are immutable");
	const trigger = find(node, Button).find((item) => item.props.className === "model-status-trigger");
	assert.ok(trigger?.props.ref && typeof trigger.props.ref === "object");
	const focusTarget = { focus: vi.fn() } as unknown as HTMLButtonElement;
	trigger.props.ref.current = focusTarget;
	const action = find(node, Button).find((item) => item.props.className === "conversation-manage-models");
	assert.ok(action?.props.onClick);
	Reflect.apply(action.props.onClick, undefined, []);
	assert.deepEqual(manageModels.mock.calls, [[focusTarget]]);
	assert.equal(only(renderExistingModel(), Popover).props.open, false);
	assert.equal(runtimeCall.mock.calls.length, 0);
	const preventDefault = vi.fn();
	only(node, PopoverContent).props.onCloseAutoFocus?.({ preventDefault } as Event);
	assert.equal(preventDefault.mock.calls.length, 1);
});

test("configured conversations keep status controls without redundant credential setup", () => {
	const node = renderExistingModel();
	assert.equal(find(only(node, PopoverContent), Button).length, 0, "Healthy status is not a manual refresh menu");
	assert.equal(find(node, Button).filter((item) => item.props.className === "conversation-manage-models").length, 0);
	assert.equal(manageModels.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
});

function recoveryController() {
	return {
		model: { isError: true, isFetching: false, refetch },
		execution: { isError: false, isPending: false, mutate: runtimeCall, reset: runtimeCall },
		observation: { connection: "connected" },
		storeMismatch: false,
	} as unknown as ConversationController;
}
function renderRecovery(controller: ConversationController) {
	hooks.cursor = 0;
	return ConversationModelAttention({ controller });
}

test.each(["read", "execution"] as const)("%s error recovery only reads state and retains command errors", (kind) => {
	const controller = recoveryController();
	controller.model.isError = kind === "read";
	controller.execution.isError = kind === "execution";
	const retry = only(renderRecovery(controller), Button);
	assert.equal(retry.props.children, "model.retryRead");
	assert.equal(retry.props.disabled, false);
	assert.ok(retry.props.onClick);
	Reflect.apply(retry.props.onClick, undefined, []);
	assert.equal(refetch.mock.calls.length, 1);
	assert.equal(controller.execution.isError, kind === "execution");
	assert.equal(runtimeCall.mock.calls.length, 0, "Retry must neither execute nor clear an uncertain mutation");
	assert.equal(sent.mock.calls.length, 0);
});

test.each(["connecting", "stale", "paused", "fetching", "pending", "storeMismatch", "recovered"] as const)(
	"conversation read retry has UI and latest-state handler guards for %s",
	(condition) => {
		const controller = recoveryController();
		const staleRetry = only(renderRecovery(controller), Button);
		assert.ok(staleRetry.props.onClick);
		const next = {
			...controller,
			model: { ...controller.model },
			execution: { ...controller.execution },
			observation: { ...controller.observation },
		};
		if (condition === "fetching") next.model.isFetching = true;
		else if (condition === "pending") next.execution.isPending = true;
		else if (condition === "storeMismatch") next.storeMismatch = true;
		else if (condition === "recovered") next.model.isError = false;
		else next.observation.connection = condition;
		const node = renderRecovery(next);
		if (condition === "recovered") assert.equal(find(node, Button).length, 0);
		else assert.equal(only(node, Button).props.disabled, true);
		Reflect.apply(staleRetry.props.onClick, undefined, []);
		assert.equal(refetch.mock.calls.length, 0);
		assert.equal(runtimeCall.mock.calls.length, 0);
	},
);

test("new-chat Send has no project consent control, staged payload or authorization call", () => {
	change("Explain the project source.");
	const node = render();
	assert.ok(find(node, Button).every((button) => button.props["aria-haspopup"] !== "dialog"));
	assert.ok(find(node, Button).every((button) => button.props.className !== "prepared-project-permissions"));
	assert.ok(find(node, "p").every((item) => item.props.className !== "prepared-context-note"));
	assert.ok(find(node, "output").every((item) => item.props.className !== "prepared-context-note"));
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(sent.mock.calls.length, 0);
	submit(node);
	submit(node);
	assert.deepEqual(sent.mock.calls, [["Explain the project source.", { provider: "faux", modelId: "one" }]]);
	assert.equal(runtimeCall.mock.calls.length, 0, "The composer never creates a project grant before Send");
	assert.equal(draft, "Explain the project source.");
});

test("closing model selection and remounting retain the draft without sending or authorizing", () => {
	change("Keep this project question.");
	models.push({ provider: "faux", modelId: "two", name: "Two" });
	only(render(), DropdownMenu).props.onOpenChange?.(true);
	only(render(), DropdownMenuRadioGroup).props.onValueChange?.('["faux","two"]');
	only(render(), DropdownMenu).props.onOpenChange?.(false);
	assert.equal(only(render(), DropdownMenu).props.open, false);
	for (const effect of hooks.effects.values()) effect.cleanup?.();
	hooks.effects.clear();
	hooks.cells = [];
	activeClient = { call: runtimeCall };
	const node = render();
	assert.equal(only(node, ComposerEditor).props.value, "Keep this project question.");
	assert.equal(only(node, DropdownMenuRadioGroup).props.value, '["faux","two"]');
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
	submit(node);
	assert.deepEqual(sent.mock.calls, [["Keep this project question.", { provider: "faux", modelId: "two" }]]);
});

test("an unconfirmed first Send keeps the exact draft and reports failure without automatic retry", async () => {
	change("Keep my original project request.");
	sent.mockRejectedValueOnce(new Error("UNCONFIRMED"));
	submit();
	await Promise.resolve();
	await Promise.resolve();
	const node = render();
	assert.ok(find(node, "p").some((item) => item.props.role === "alert" && item.props.className === "notice"));
	assert.equal(only(node, ComposerEditor).props.value, "Keep my original project request.");
	assert.equal(local.read("task-draft.project"), "Keep my original project request.");
	assert.equal(sent.mock.calls.length, 1);
	assert.equal(runtimeCall.mock.calls.length, 0);
});
