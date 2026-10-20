import assert from "node:assert/strict";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { Button } from "../../../src/components/ui/button.tsx";
import { Dialog, DialogContent } from "../../../src/components/ui/dialog.tsx";
import { Input } from "../../../src/components/ui/input.tsx";
import { ProjectRenameDialog } from "../../../src/features/workbench/projects/rename.tsx";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));

// Bounded production-callback adapter. Native focus order, portals, and IME
// dispatch still require browser acceptance; only explicit handlers run here.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useId: () => `project-name-${hooks.cursor++}`,
		useState: <T,>(initial: T) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) hooks.cells[index] = initial;
			return [
				hooks.cells[index],
				(value: React.SetStateAction<T>) => {
					hooks.cells[index] =
						typeof value === "function" ? (value as (previous: T) => T)(hooks.cells[index] as T) : value;
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
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en" }),
}));

const onSave = vi.fn<(name: string) => void>();
const onClose = vi.fn();
const onReturnFocus = vi.fn();

function render(extra: Partial<React.ComponentProps<typeof ProjectRenameDialog>> = {}) {
	hooks.cursor = 0;
	return ProjectRenameDialog({
		name: "Original project",
		disabled: false,
		busy: false,
		pending: false,
		failed: false,
		onSave,
		onClose,
		onReturnFocus,
		...extra,
	});
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

function only<C extends React.ElementType>(node: React.ReactNode, type: C) {
	const found = elements(node, type);
	assert.equal(found.length, 1);
	const result = found[0];
	assert.ok(result);
	return result;
}

function invoke(callback: unknown, args: unknown[] = []) {
	assert.ok(typeof callback === "function");
	return Reflect.apply(callback, undefined, args);
}

function button(node: React.ReactNode, action: "save" | "cancel") {
	const result = elements(node, Button).find((entry) => entry.props.className === `project-rename-${action}`);
	assert.ok(result?.props.onClick);
	return result;
}

function change(value: string) {
	invoke(only(render(), Input).props.onChange, [{ target: { value } }]);
}

function enter(node = render(), overrides: Partial<KeyboardEvent> = {}) {
	const preventDefault = vi.fn();
	invoke(only(node, Input).props.onKeyDown, [
		{
			preventDefault,
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
				...overrides,
			},
		},
	]);
	return preventDefault;
}

beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
	vi.clearAllMocks();
});

test("a mounted rename keeps its initial name and edited draft across project refresh and failed state", () => {
	assert.equal(only(render(), Input).props.value, "Original project");
	assert.equal(only(render({ name: "Remote rename" }), Input).props.value, "Original project");
	change("Keep my unsaved project name");
	const node = render({ name: "New server name", failed: true });
	assert.equal(only(node, Input).props.value, "Keep my unsaved project name");
	assert.equal(only(node, Dialog).props.open, true);
	assert.equal(only(node, "p").props.role, "alert");
	assert.equal(onSave.mock.calls.length, 0);
	assert.equal(onClose.mock.calls.length, 0);
});

test("Save and plain Enter pass trimmed names without mutating the owned draft or closing early", () => {
	change("  Renamed project  ");
	const node = render();
	assert.equal(button(node, "save").props.disabled, false);
	invoke(button(node, "save").props.onClick);
	assert.equal(enter().mock.calls.length, 1);
	assert.deepEqual(onSave.mock.calls, [["Renamed project"], ["Renamed project"]]);
	assert.equal(only(render(), Input).props.value, "  Renamed project  ");
	assert.equal(onClose.mock.calls.length, 0, "The command owner decides when success closes the dialog");
});

test.each([
	["blank", " \t "],
	["overlength", "x".repeat(129)],
])("%s names disable Save and cannot bypass validation through callbacks or Enter", (_kind, value) => {
	change(value);
	const node = render();
	assert.equal(only(node, Input).props.maxLength, 128);
	assert.equal(button(node, "save").props.disabled, true);
	invoke(button(node, "save").props.onClick);
	enter(node);
	assert.equal(onSave.mock.calls.length, 0);
});

test("IME confirmation, repeat, modified native Enter and implicit form submit never save", () => {
	change("中文项目");
	invoke(only(render(), Input).props.onCompositionStart);
	assert.equal(enter().mock.calls.length, 0, "Composition retains native key handling");
	invoke(only(render(), Input).props.onCompositionEnd, [{ timeStamp: 1000 }]);
	assert.equal(enter(render(), { timeStamp: 1050 }).mock.calls.length, 1);
	invoke(only(render(), Input).props.onKeyUp);
	assert.equal(enter(render(), { isComposing: true }).mock.calls.length, 0);
	assert.equal(enter(render(), { keyCode: 229 }).mock.calls.length, 0);
	assert.equal(enter(render(), { repeat: true }).mock.calls.length, 1);
	assert.equal(enter(render(), { shiftKey: true }).mock.calls.length, 0);
	assert.equal(enter(render(), { altKey: true }).mock.calls.length, 0);
	const submit = new Event("submit", { cancelable: true });
	invoke(only(render(), "form").props.onSubmit, [submit]);
	assert.equal(submit.defaultPrevented, true);
	assert.equal(onSave.mock.calls.length, 0);
});

test("keyup and blur release composition guards without changing the draft", () => {
	change("项目名称");
	invoke(only(render(), Input).props.onCompositionEnd, [{ timeStamp: 990 }]);
	enter();
	assert.equal(onSave.mock.calls.length, 0);
	invoke(only(render(), Input).props.onKeyUp);
	enter();
	invoke(only(render(), Input).props.onCompositionStart);
	enter();
	assert.equal(onSave.mock.calls.length, 1);
	invoke(only(render(), Input).props.onBlur);
	enter();
	assert.deepEqual(onSave.mock.calls, [["项目名称"], ["项目名称"]]);
});

test.each(["disabled", "busy", "pending"] as const)("%s blocks editing and both save paths", (state) => {
	change("Retained draft");
	const node = render({ [state]: true });
	assert.equal(only(node, Input).props.disabled, true);
	assert.equal(button(node, "save").props.disabled, true);
	invoke(button(node, "save").props.onClick);
	enter(node);
	assert.equal(onSave.mock.calls.length, 0);
	assert.equal(only(node, Input).props.value, "Retained draft");
});

test("busy blocks Cancel, root dismissal, Escape, and the shared close control", () => {
	const node = render({ busy: true });
	assert.equal(button(node, "cancel").props.disabled, true);
	assert.equal(only(node, DialogContent).props.closeDisabled, true);
	invoke(button(node, "cancel").props.onClick);
	only(node, Dialog).props.onOpenChange?.(false);
	const escapeEvent = new Event("keydown", { cancelable: true });
	invoke(only(node, DialogContent).props.onEscapeKeyDown, [escapeEvent]);
	assert.equal(escapeEvent.defaultPrevented, true);
	assert.equal(onClose.mock.calls.length, 0);
	invoke(button(render(), "cancel").props.onClick);
	assert.equal(onClose.mock.calls.length, 1, "Closing is available again after busy clears");
});

test("pending recovery labels Cancel as Close and permits dismissal without saving or discarding input", () => {
	change("Unconfirmed project name");
	const node = render({ pending: true, failed: true });
	assert.equal(button(node, "cancel").props.children, "Close");
	assert.equal(button(node, "cancel").props.disabled, false);
	assert.equal(only(node, DialogContent).props.closeDisabled, false);
	assert.equal(elements(node, "p").filter((entry) => entry.props.role === "alert").length, 2);
	invoke(button(node, "cancel").props.onClick);
	only(node, Dialog).props.onOpenChange?.(false);
	const escapeEvent = new Event("keydown", { cancelable: true });
	invoke(only(node, DialogContent).props.onEscapeKeyDown, [escapeEvent]);
	assert.equal(escapeEvent.defaultPrevented, false);
	assert.equal(onClose.mock.calls.length, 2);
	assert.equal(onSave.mock.calls.length, 0);
	assert.equal(only(render(), Input).props.value, "Unconfirmed project name");
});

test("IME Escape is guarded while open autofocus selects the input and close returns to its source", () => {
	const node = render();
	const input = only(node, Input);
	const content = only(node, DialogContent);
	assert.ok(input.props.ref && typeof input.props.ref === "object");
	const focus = vi.fn();
	const select = vi.fn();
	Object.assign(input.props.ref, { current: { focus, select } });
	const open = new Event("open", { cancelable: true });
	content.props.onOpenAutoFocus?.(open);
	assert.equal(open.defaultPrevented, true);
	assert.equal(focus.mock.calls.length, 1);
	assert.equal(select.mock.calls.length, 1);
	assert.equal(only(node, "label").props.htmlFor, input.props.id);
	assert.equal(button(node, "cancel").props.children, "Cancel");
	for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
		const escapeEvent = Object.assign(new Event("keydown", { cancelable: true }), flags);
		invoke(content.props.onEscapeKeyDown, [escapeEvent]);
		assert.equal(escapeEvent.defaultPrevented, true);
	}
	const close = new Event("close", { cancelable: true });
	content.props.onCloseAutoFocus?.(close);
	assert.equal(close.defaultPrevented, true);
	assert.equal(onReturnFocus.mock.calls.length, 1);
	assert.equal(onSave.mock.calls.length, 0);
	assert.equal(onClose.mock.calls.length, 0);
});
