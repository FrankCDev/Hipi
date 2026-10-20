import assert from "node:assert/strict";
import type { ModelReference } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";

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
			models: [{ provider: "faux", modelId: "one", name: "One" }],
			providers: [{ provider: "faux", credentialState }],
		},
		isPending: false,
		isError: catalogFailed,
		refetch: vi.fn(),
	}),
}));
let local = new LocalState();
let credentialState = "configured";
let catalogFailed = false;
let draft = "";
const runtimeCall = vi.fn();
const sent = vi.fn(async (_text: string, _model: ModelReference) => {});
const manageModels = vi.fn();
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
	sent.mockReset();
	sent.mockResolvedValue(undefined);
	runtimeCall.mockClear();
	manageModels.mockClear();
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
	const action = find(render(), Button).find((item) => item.props.className === "new-chat-manage-models");
	assert.ok(action?.props.onClick);
	Reflect.apply(action.props.onClick, undefined, []);
	assert.equal(manageModels.mock.calls.length, 1);
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(only(render(), Textarea).props.value, "My detailed goal");
});
