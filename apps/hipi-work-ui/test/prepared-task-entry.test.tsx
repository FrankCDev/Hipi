import assert from "node:assert/strict";
import type { ModelReference } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import {
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "../src/components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent } from "../src/components/ui/popover.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { ConversationModelControls } from "../src/features/workbench/conversation-model.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";
import type { ConversationController } from "../src/features/workbench/use-conversation.ts";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
// Production handlers and synchronous submission fence; DOM sizing/focus stay native acceptance gates.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useLayoutEffect: () => {},
		useId: () => `input-${hooks.cursor++}`,
		useState: <T,>(initial: T | (() => T)) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells))
				hooks.cells[index] = typeof initial === "function" ? (initial as () => T)() : initial;
			return [
				hooks.cells[index],
				(value: T) => {
					hooks.cells[index] = value;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
			return hooks.cells[index];
		},
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("../src/app/client-provider.tsx", () => ({
	useLocalState: () => local,
	useAppClient: () => ({ call: runtimeCall }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			models,
			providers: [{ provider: "faux", name: "Faux", credentialState }],
		},
		isPending: false,
		isError: catalogFailed,
		refetch,
	}),
}));
let local = new LocalState();
let credentialState = "configured";
let catalogFailed = false;
let models = [{ provider: "faux", modelId: "one", name: "One" }];
let draft = "";
const runtimeCall = vi.fn();
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
	hooks.cursor = 0;
	return PreparedTaskEntry({
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
}
function change(value: string) {
	const handler = only(render(), Textarea).props.onChange;
	assert.ok(handler);
	Reflect.apply(handler, undefined, [{ target: { value } }]);
}
function submit(node = render()) {
	const handler = only(node, "form").props.onSubmit;
	assert.ok(handler);
	Reflect.apply(handler, undefined, [{ preventDefault() {} }]);
}
function key(nativeEvent: Record<string, unknown>) {
	const handler = only(render(), Textarea).props.onKeyDown;
	assert.ok(handler);
	const preventDefault = vi.fn();
	Reflect.apply(handler, undefined, [
		{
			nativeEvent: {
				key: "Enter",
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				altKey: false,
				isComposing: false,
				keyCode: 13,
				repeat: false,
				timeStamp: 1000,
				...nativeEvent,
			},
			preventDefault,
		},
	]);
	return preventDefault;
}
beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	local = new LocalState();
	draft = "";
	credentialState = "configured";
	catalogFailed = false;
	models = [{ provider: "faux", modelId: "one", name: "One" }];
	sent.mockReset();
	sent.mockResolvedValue(undefined);
	runtimeCall.mockClear();
	manageModels.mockClear();
	refetch.mockClear();
});
test("opening and editing new chat never creates an object or sends", () => {
	render();
	change("A goal\nwith constraints");
	assert.equal(only(render(), Textarea).props.value, "A goal\nwith constraints");
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
test("Enter sends once while Shift+Enter, IME Enter and repeat remain protected", () => {
	change("Hello");
	assert.equal(key({ shiftKey: true }).mock.calls.length, 0);
	assert.equal(key({ isComposing: true, keyCode: 229 }).mock.calls.length, 0);
	assert.equal(key({ repeat: true }).mock.calls.length, 1);
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(key({}).mock.calls.length, 1);
	assert.equal(sent.mock.calls.length, 1);
});
test("composition-end confirming Enter does not send", () => {
	change("你好");
	const input = only(render(), Textarea);
	assert.ok(input.props.onCompositionStart);
	Reflect.apply(input.props.onCompositionStart, undefined, []);
	key({});
	assert.equal(sent.mock.calls.length, 0);
	assert.ok(input.props.onCompositionEnd);
	Reflect.apply(input.props.onCompositionEnd, undefined, [{ timeStamp: 990 }]);
	key({});
	assert.equal(sent.mock.calls.length, 0);
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
	assert.equal(only(render(), Textarea).props.value, "My detailed goal");
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

test("model Refresh retains the open menu, while ordinary dismissal keeps library focus restoration", () => {
	const node = render();
	const refresh = find(node, DropdownMenuItem).find((item) => item.props.className !== "new-chat-manage-models");
	const preventDefault = vi.fn();
	assert.ok(refresh?.props.onSelect);
	Reflect.apply(refresh.props.onSelect, undefined, [{ preventDefault }]);
	assert.equal(preventDefault.mock.calls.length, 1);
	assert.equal(refetch.mock.calls.length, 1);
	preventDefault.mockClear();
	only(node, DropdownMenuContent).props.onCloseAutoFocus?.({ preventDefault } as Event);
	assert.equal(preventDefault.mock.calls.length, 0);
});

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
	assert.equal(find(node, Button).filter((item) => item.props.className === "conversation-manage-models").length, 0);
	assert.equal(manageModels.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
});
