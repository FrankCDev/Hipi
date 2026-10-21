import assert from "node:assert/strict";
import type { ModelReference } from "@hipi/work-runtime/contracts";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { Button } from "../../../src/components/ui/button.tsx";
import {
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "../../../src/components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent } from "../../../src/components/ui/popover.tsx";
import { Select } from "../../../src/components/ui/select.tsx";
import { Textarea } from "../../../src/components/ui/textarea.tsx";
import type { StagedProjectConsent } from "../../../src/features/workbench/catalog/initial-context.ts";
import { ComposerEditor } from "../../../src/features/workbench/composer/editor.tsx";
import { PreparedTaskEntry } from "../../../src/features/workbench/composer/prepared-entry.tsx";
import { PreparedProjectConsent } from "../../../src/features/workbench/composer/project-consent.tsx";
import { ConversationModelControls } from "../../../src/features/workbench/conversation/model.tsx";
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
	useFiles: () => ({ fileAuthority: activeAuthority }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) =>
		queryKey[0] === "projectFolder"
			? {
					data: folder,
					isError: false,
					isFetching: false,
				}
			: {
					data: {
						models,
						providers: [{ provider: "faux", name: "Faux", credentialState }],
					},
					isPending: false,
					isError: catalogFailed,
					refetch,
				},
}));
let local = new LocalState();
let credentialState = "configured";
let catalogFailed = false;
let models = [{ provider: "faux", modelId: "one", name: "One" }];
let draft = "";
let folder: ProjectFolder;
const runtimeCall = vi.fn();
let activeClient = { call: runtimeCall };
let activeAuthority = { getProject: runtimeCall };
const sent = vi.fn(async (_text: string, _model: ModelReference, _context?: StagedProjectConsent) => {});
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
	activeAuthority = { getProject: runtimeCall };
	draft = "";
	credentialState = "configured";
	catalogFailed = false;
	models = [{ provider: "faux", modelId: "one", name: "One" }];
	folder = {
		workspaceId: "project",
		bindingId: "binding",
		revision: 1,
		status: "available",
		displayName: "Project source",
		root: { workspaceId: "project", rootId: "opaque-root", writable: false, displayName: "Project source" },
	};
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

function consentIntent(): StagedProjectConsent {
	assert.ok(folder.bindingId && folder.root);
	return {
		workspaceId: folder.workspaceId,
		bindingId: folder.bindingId,
		bindingRevision: folder.revision,
		rootId: folder.root.rootId,
		model: { provider: "faux", modelId: "one" },
		pathPrefixes: [""],
		expiresAt: Date.now() + 900000,
		disclosureVersion: 1,
	};
}
function permissions() {
	const entry = find(render({ workspaceId: "project" }), Button).find(
		(button) => button.props.className === "prepared-project-permissions",
	);
	assert.ok(entry?.props.onClick);
	Reflect.apply(entry.props.onClick, undefined, []);
	return only(render({ workspaceId: "project" }), PreparedProjectConsent).props;
}

test("project permissions are off initially; opening and Cancel never create a chat, grant access, or lose the prompt", () => {
	change("Which files are in my project?");
	const dialog = permissions();
	assert.equal(dialog.value, undefined);
	dialog.onClose();
	const node = render({ workspaceId: "project" });
	assert.equal(find(node, PreparedProjectConsent).length, 0);
	assert.equal(only(node, ComposerEditor).props.value, "Which files are in my project?");
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(sent.mock.calls.length, 0);
	submit(node);
	assert.deepEqual(sent.mock.calls, [["Which files are in my project?", { provider: "faux", modelId: "one" }]]);
});

test("one Send forwards only explicitly staged project consent; staging itself has no runtime side effect", () => {
	change("Explain the project source.");
	const dialog = permissions();
	const intent = consentIntent();
	dialog.onChange(intent);
	dialog.onClose();
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(sent.mock.calls.length, 0);
	const node = render({ workspaceId: "project" });
	assert.ok(find(node, Button).some((button) => button.props["data-staged"] === true));
	submit(node);
	submit(node);
	assert.deepEqual(sent.mock.calls, [["Explain the project source.", { provider: "faux", modelId: "one" }, intent]]);
	assert.equal(draft, "Explain the project source.");
});

test.each(["model", "binding", "root", "expiry", "workspace", "client", "authority"] as const)(
	"%s changes invalidate staged consent without sending or changing the prompt",
	(changeKind) => {
		vi.useFakeTimers();
		change("Retain this file question.");
		permissions().onChange(consentIntent());
		render({ workspaceId: "project" });
		if (changeKind === "model") {
			models.push({ provider: "faux", modelId: "two", name: "Two" });
			only(render({ workspaceId: "project" }), DropdownMenuRadioGroup).props.onValueChange?.('["faux","two"]');
		} else if (changeKind === "binding") {
			folder = { ...folder, revision: 2 };
		} else if (changeKind === "root") {
			assert.ok(folder.root);
			folder = { ...folder, root: { ...folder.root, rootId: "replacement-root" } };
		} else if (changeKind === "expiry") vi.advanceTimersByTime(900001);
		else if (changeKind === "client") activeClient = { call: runtimeCall };
		else if (changeKind === "authority") activeAuthority = { getProject: runtimeCall };
		const node = render({ workspaceId: changeKind === "workspace" ? "other" : "project" });
		assert.ok(find(node, Button).every((button) => button.props["data-staged"] !== true));
		assert.equal(only(node, ComposerEditor).props.value, "Retain this file question.");
		assert.equal(runtimeCall.mock.calls.length, 0);
		assert.equal(sent.mock.calls.length, 0);
		assert.ok(find(node, "output").some((item) => item.props.className === "prepared-context-note"));
	},
);

test("a fresh composer never restores staged consent from persisted prompt or selected model", () => {
	change("Keep saved prompt.");
	permissions().onChange(consentIntent());
	render({ workspaceId: "project" });
	for (const effect of hooks.effects.values()) effect.cleanup?.();
	hooks.effects.clear();
	hooks.cells = [];
	const node = render({ workspaceId: "project" });
	assert.ok(find(node, Button).every((button) => button.props["data-staged"] !== true));
	assert.equal(only(node, ComposerEditor).props.value, "Keep saved prompt.");
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(runtimeCall.mock.calls.length, 0);
});

test("prepared consent form captures friendly project/model/path/expiry values without calling a runtime", () => {
	const onChange = vi.fn();
	const onClose = vi.fn();
	const draw = () => {
		hooks.cursor = 0;
		return PreparedProjectConsent({
			folder,
			model: { provider: "faux", modelId: "one" },
			disabled: false,
			onChange,
			onClose,
			onRestoreFocus() {},
		});
	};
	let node = draw();
	assert.ok(find(node, "strong").some((item) => item.props.children === "Project source"));
	assert.equal(find(node, "input").length, 0, "Internal folder IDs are never editable fields");
	find(node, Select)[0]?.props.onValueChange?.("paths");
	node = draw();
	only(node, Textarea).props.onChange?.({
		target: { value: "src\nREADME.md" },
	} as React.ChangeEvent<HTMLTextAreaElement>);
	find(draw(), Select)[1]?.props.onValueChange?.("3600000");
	const confirm = find(draw(), Button).find((item) => item.props.children === "Use these permissions on Send");
	assert.ok(confirm && !confirm.props.disabled && confirm.props.onClick);
	const before = Date.now();
	Reflect.apply(confirm.props.onClick, undefined, []);
	const staged = onChange.mock.calls[0]?.[0] as StagedProjectConsent;
	assert.deepEqual(staged.pathPrefixes, ["src", "README.md"]);
	assert.deepEqual(staged.model, { provider: "faux", modelId: "one" });
	assert.equal(staged.rootId, "opaque-root");
	assert.equal(staged.bindingRevision, 1);
	assert.ok(staged.expiresAt >= before + 3600000 && staged.expiresAt <= Date.now() + 3600000);
	assert.equal(onClose.mock.calls.length, 1);
	assert.equal(runtimeCall.mock.calls.length, 0);
});

test("invalid paths and stale prepared-consent callbacks cannot stage a wider or replaced folder", () => {
	const onChange = vi.fn();
	const draw = () => {
		hooks.cursor = 0;
		return PreparedProjectConsent({
			folder,
			model: { provider: "faux", modelId: "one" },
			disabled: false,
			onChange,
			onClose() {},
			onRestoreFocus() {},
		});
	};
	const initial = draw();
	const oldConfirm = find(initial, Button).find((item) => item.props.children === "Use these permissions on Send");
	assert.ok(oldConfirm?.props.onClick);
	folder = { ...folder, revision: 2 };
	draw();
	Reflect.apply(oldConfirm.props.onClick, undefined, []);
	assert.equal(onChange.mock.calls.length, 0);
	find(draw(), Select)[0]?.props.onValueChange?.("paths");
	only(draw(), Textarea).props.onChange?.({
		target: { value: "../private" },
	} as React.ChangeEvent<HTMLTextAreaElement>);
	const invalid = find(draw(), Button).find((item) => item.props.children === "Use these permissions on Send");
	assert.ok(invalid?.props.disabled && invalid.props.onClick);
	Reflect.apply(invalid.props.onClick, undefined, []);
	assert.equal(onChange.mock.calls.length, 0);
});
