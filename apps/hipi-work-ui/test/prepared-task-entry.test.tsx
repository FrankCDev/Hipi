import assert from "node:assert/strict";
import type { ModelReference } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { Select } from "../src/components/ui/select.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { ConversationStarters } from "../src/features/workbench/conversation-starters.tsx";
import { CreateDialog } from "../src/features/workbench/create-dialog.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
// Invoke production callbacks without emulating DOM reconciliation. Native tests
// separately cover composition events, modal focus and actual input persistence.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
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
type InputPayload = { name: string; model?: ModelReference; draft?: string };
type MutationOptions = {
	mutationFn: (input: InputPayload) => Promise<void>;
	onSuccess: () => void;
	onSettled: () => void;
};
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			models: [{ provider: "faux", modelId: "one", name: "One" }],
			providers: [{ provider: "faux", credentialState: "configured" }],
		},
		isPending: false,
		isError: false,
		refetch: vi.fn(),
	}),
	useMutation: (options: MutationOptions) => ({
		isPending: pending,
		isError: failed,
		reset: () => {
			failed = false;
		},
		mutate: (input: InputPayload) => {
			pending = true;
			completion = options
				.mutationFn(input)
				.then(options.onSuccess, () => {
					failed = true;
				})
				.finally(() => {
					pending = false;
					options.onSettled();
				});
		},
	}),
}));
let local = new LocalState();
let pending = false;
let failed = false;
let completion = Promise.resolve();
const runtimeCall = vi.fn();
const created = vi.fn(async (_title: string, _model?: ModelReference, _draft?: string) => {});
const props = { kind: "conversation" as const, workspaceId: "project", onCreate: created };
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
function render(extra: Partial<React.ComponentProps<typeof CreateDialog>> = {}) {
	hooks.cursor = 0;
	return CreateDialog({ ...props, ...extra });
}
function changeGoal(value: string) {
	const handler = only(render(), Textarea).props.onChange;
	assert.ok(handler);
	Reflect.apply(handler, undefined, [{ target: { value } }]);
}
function selectModel() {
	only(render(), Select).props.onValueChange?.(JSON.stringify(["faux", "one"]));
}
function confirm(node = render()) {
	const button = find(node, Button).find((item) => item.props.className === "task-create-confirm");
	assert.ok(button);
	return button;
}
beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	local = new LocalState();
	pending = false;
	failed = false;
	completion = Promise.resolve();
	created.mockReset();
	created.mockResolvedValue(undefined);
	runtimeCall.mockClear();
});

test("goal edits and setup cancel/reopen retain the project draft without creating or submitting", () => {
	changeGoal("A goal\nwith a second line");
	only(render(), Dialog).props.onOpenChange?.(false);
	only(render(), Dialog).props.onOpenChange?.(true);
	assert.equal(only(render(), Textarea).props.value, "A goal\nwith a second line");
	assert.equal(local.read("task-draft.project"), "A goal\nwith a second line");
	assert.equal(created.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(confirm().props.disabled, true, "Model choice remains explicit");
});

test("conversation form submit is inert; only explicit confirm captures goal, title and chosen model once", async () => {
	changeGoal("  Prepare the launch\nKeep the detailed constraints. ");
	selectModel();
	const form = only(render(), "form");
	const prevented = vi.fn();
	assert.ok(form.props.onSubmit);
	Reflect.apply(form.props.onSubmit, undefined, [{ preventDefault: prevented }]);
	assert.equal(prevented.mock.calls.length, 1);
	assert.equal(created.mock.calls.length, 0, "IME or implicit form submission never creates a task");
	const action = confirm();
	assert.equal(action.props.type, "button");
	assert.equal(action.props.disabled, false);
	assert.ok(action.props.onClick);
	Reflect.apply(action.props.onClick, undefined, []);
	Reflect.apply(action.props.onClick, undefined, []);
	await completion;
	assert.deepEqual(created.mock.calls, [
		[
			"Prepare the launch",
			{ provider: "faux", modelId: "one" },
			"  Prepare the launch\nKeep the detailed constraints. ",
		],
	]);
	assert.equal(runtimeCall.mock.calls.length, 0);
});

test("explicit title wins and untouched empty conversations remain supported", async () => {
	const input = only(render(), Input);
	assert.ok(input.props.onChange);
	Reflect.apply(input.props.onChange, undefined, [{ target: { value: " Exact fixture title " } }]);
	selectModel();
	const action = confirm();
	assert.ok(action.props.onClick);
	Reflect.apply(action.props.onClick, undefined, []);
	await completion;
	assert.deepEqual(created.mock.calls, [["Exact fixture title", { provider: "faux", modelId: "one" }, undefined]]);
});

test("unknown creation keeps input and prevents replacement through a closed/reopened blocked setup", async () => {
	changeGoal("Keep this original goal");
	selectModel();
	created.mockRejectedValueOnce(new Error("UNCONFIRMED"));
	const action = confirm();
	assert.ok(action.props.onClick);
	Reflect.apply(action.props.onClick, undefined, []);
	await completion;
	assert.equal(confirm().props.disabled, true);
	only(render(), Dialog).props.onOpenChange?.(false);
	only(render(), Dialog).props.onOpenChange?.(true);
	assert.equal(only(render(), Textarea).props.value, "Keep this original goal");
	const blocked = confirm(render({ disabled: true }));
	assert.equal(blocked.props.disabled, true);
	assert.ok(blocked.props.onClick);
	Reflect.apply(blocked.props.onClick, undefined, []);
	assert.equal(created.mock.calls.length, 1);
	assert.equal(local.read("task-draft.project"), "Keep this original goal");
});

test("project-home suggestions only prepare editable input and never replace later input", () => {
	let draft = "";
	const draw = () => {
		hooks.cursor = 0;
		return PreparedTaskEntry({
			workspaceId: "project",
			disabled: false,
			onCreate: created,
			draft,
			onDraftChange: (value) => {
				draft = value;
				local.write("task-draft.project", value);
			},
		});
	};
	only(draw(), ConversationStarters).props.onSelect("Suggested goal");
	assert.equal(local.read("task-draft.project"), "Suggested goal");
	assert.equal(only(draw(), Textarea).props.value, "Suggested goal");
	only(draw(), ConversationStarters).props.onSelect("Replacement");
	assert.equal(local.read("task-draft.project"), "Suggested goal");
	assert.equal(only(draw(), CreateDialog).props.draft, "Suggested goal");
	assert.equal(created.mock.calls.length, 0);
});
