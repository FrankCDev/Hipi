import assert from "node:assert/strict";
import type { AgentContextRequest } from "@hipi/work-runtime/contracts";
import type { FileRoot, ProjectFolder } from "@hipi/work-runtime/files";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { FileAuthority } from "../../../src/app/file-client.ts";
import { Button } from "../../../src/components/ui/button.tsx";
import { Dialog } from "../../../src/components/ui/dialog.tsx";
import { Input } from "../../../src/components/ui/input.tsx";
import { Select } from "../../../src/components/ui/select.tsx";
import { ContextDialog } from "../../../src/features/agent-permissions/context-dialog.tsx";
import type { PermissionSession } from "../../../src/features/agent-permissions/permission-session.ts";
import { CreateDialog } from "../../../src/features/workbench/catalog/create-dialog.tsx";
import { ProjectFolderDialog } from "../../../src/features/workbench/projects/folder.tsx";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
// Production callbacks and lifecycle fences. Native dialog/focus/layout acceptance is separate.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useId: () => "project-field",
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T) => {
					cell.value = next;
					hooks.changed = true;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index].value;
		},
		useMemo: <T,>(create: () => T, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const prior = hooks.cells[index];
			if (!prior || !prior.deps || deps.some((value, i) => value !== prior.deps?.[i]))
				hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const prior = hooks.cells[index];
			if (!prior || !prior.deps || deps.some((value, i) => value !== prior.deps?.[i]))
				hooks.commits.push(() => {
					prior?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("../../../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useFiles: () => ({ fileAuthority: authority, files: {} }) }));
vi.mock("../../../src/features/workbench/projects/use-folder.ts", () => ({ useProjectFolder: () => projectQuery }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => cache,
	useQuery: () => ({ data: roots, isFetching: false, isError: false, isPending: false }),
	useMutation: (options: { mutationFn: (value: string) => Promise<void>; onSuccess(): void; onSettled(): void }) => ({
		isPending: false,
		isError: false,
		reset() {},
		mutate(value: string) {
			void options.mutationFn(value).then(options.onSuccess).finally(options.onSettled);
		},
	}),
}));
const root: FileRoot = { workspaceId: "project", rootId: "internal-root", displayName: "My files", writable: false };
let folder: ProjectFolder;
let roots: FileRoot[];
let authority: FileAuthority;
const cache = {
	getQueryData: () => folder,
	setQueryData: (_key: unknown, result: ProjectFolder) => {
		folder = result;
		projectQuery.data = result;
	},
	invalidateQueries: vi.fn(async () => {}),
};
const projectQuery = {
	data: undefined as ProjectFolder | undefined,
	isError: false,
	isFetching: false,
	refetch: vi.fn(async () => ({ data: folder, isError: false })),
};
beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	hooks.cells = [];
	hooks.cursor = 0;
	hooks.commits = [];
	folder = {
		workspaceId: "project",
		bindingId: "binding",
		revision: 1,
		status: "available",
		displayName: "My files",
		root,
	};
	projectQuery.data = folder;
	roots = [root];
	authority = {
		chooseRoot: vi.fn(async () => {}),
		revokeRoot: vi.fn(async () => {}),
		chooseProject: vi.fn(async () => null),
		unbindProject: vi.fn(async () => ({ ...folder, status: "revoked", revision: 2, root: null })),
	};
	vi.clearAllMocks();
});
afterEach(() => {
	for (const cell of hooks.cells) cell.cleanup?.();
	vi.unstubAllGlobals();
});
function elements<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const children = elements(node.props.children, type);
	return node.type === type && isValidElement<React.ComponentProps<C>>(node) ? [node, ...children] : children;
}
function render(action: () => React.ReactNode) {
	hooks.cursor = 0;
	const result = action();
	for (const commit of hooks.commits.splice(0)) commit();
	return result;
}
function button(node: React.ReactNode, label: string) {
	const result = elements(node, Button).find((item) =>
		(Array.isArray(item.props.children) ? item.props.children : [item.props.children]).includes(label),
	);
	assert.ok(result, `Missing button: ${label}`);
	return result;
}
function click(node: React.ReactElement<React.ComponentProps<typeof Button>>) {
	assert.equal(!!node.props.disabled, false);
	Reflect.apply(node.props.onClick as () => void, undefined, []);
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("folder selection and native cancellation never create a project; final Create forwards only an opaque selection", async () => {
	const create = vi.fn(async () => {});
	const pick = vi.fn(async () => null as { selectionId: string; displayName: string } | null);
	const forget = vi.fn(async () => {});
	const props = { kind: "workspace" as const, onCreate: create, chooseFolder: pick, forgetFolder: forget };
	const draw = () => render(() => CreateDialog(props));
	let content = draw();
	elements(content, Dialog)[0]?.props.onOpenChange?.(true);
	elements(content, Input)[0]?.props.onChange?.({
		target: { value: "My project" },
	} as React.ChangeEvent<HTMLInputElement>);
	content = draw();
	click(button(content, "Choose a project folder (optional)"));
	await settle();
	assert.equal(create.mock.calls.length, 0);
	assert.equal(elements(draw(), Input)[0]?.props.value, "My project");
	pick.mockImplementation(async () => ({ selectionId: "opaque-selection", displayName: "My files" }));
	click(button(draw(), "Choose a project folder (optional)"));
	await settle();
	assert.equal(create.mock.calls.length, 0);
	click(button(draw(), "common.create"));
	await settle();
	assert.deepEqual(create.mock.calls, [["My project", { selectionId: "opaque-selection", displayName: "My files" }]]);
});
test("closing the project draft forgets its selected folder without creating anything", async () => {
	const create = vi.fn(async () => {});
	const forget = vi.fn(async () => {});
	const chooseFolder = async () => ({ selectionId: "selection", displayName: "Files" });
	const draw = () =>
		render(() =>
			CreateDialog({
				kind: "workspace",
				onCreate: create,
				chooseFolder,
				forgetFolder: forget,
			}),
		);
	click(button(draw(), "Choose a project folder (optional)"));
	await settle();
	elements(draw(), Dialog)[0]?.props.onOpenChange?.(false);
	await settle();
	assert.deepEqual(forget.mock.calls, [["selection"]]);
	assert.equal(create.mock.calls.length, 0);
});
test.each(["unmount", "replace-host"] as const)(
	"a late native folder selection after %s is forgotten and never becomes a new project",
	async (mode) => {
		const pending = Promise.withResolvers<{ selectionId: string; displayName: string } | null>();
		const create = vi.fn(async () => {});
		const forget = vi.fn(async () => {});
		let chooseFolder = () => pending.promise;
		const draw = () =>
			render(() =>
				CreateDialog({
					kind: "workspace",
					onCreate: create,
					chooseFolder,
					forgetFolder: forget,
				}),
			);
		click(button(draw(), "Choose a project folder (optional)"));
		if (mode === "unmount") {
			for (const cell of hooks.cells) cell.cleanup?.();
		} else {
			chooseFolder = async () => null;
			draw();
		}
		pending.resolve({ selectionId: "late-selection", displayName: "Old host folder" });
		await settle();
		assert.deepEqual(forget.mock.calls, [["late-selection"]]);
		assert.equal(create.mock.calls.length, 0);
		if (mode === "replace-host") {
			const current = draw();
			assert.equal(button(current, "Choose a project folder (optional)").props.disabled, false);
			assert.equal(elements(current, Input)[0]?.props.value, "");
		}
	},
);
test("a cancelled replacement leaves binding untouched; unknown unbind is never blindly replayed", async () => {
	const draw = () => render(() => ProjectFolderDialog({ workspaceId: "project", name: "Project", onClose() {} }));
	click(button(draw(), "Choose another folder"));
	await settle();
	assert.equal(folder.bindingId, "binding");
	assert.equal(cache.invalidateQueries.mock.calls.length, 0);
	authority.unbindProject = vi.fn(async () => {
		throw new Error("Lost response");
	});
	click(button(draw(), "Disconnect folder"));
	await settle();
	assert.equal(authority.unbindProject.mock.calls.length, 1);
	const failed = draw();
	assert.equal(button(failed, "Disconnect folder").props.disabled, true);
	click(button(failed, "Check folder"));
	await settle();
	assert.equal(projectQuery.refetch.mock.calls.length, 1);
	assert.equal(authority.unbindProject.mock.calls.length, 1);
});
test("project context is selected by trusted binding, not typed root identifiers, and view alone never authorizes", async () => {
	const authorized: AgentContextRequest[] = [];
	const session = {
		authorize: async (input: AgentContextRequest) => {
			authorized.push(input);
		},
		getSnapshot: () => ({ failed: false, uncertain: false }),
	} as unknown as PermissionSession;
	let scope = { workspaceId: "project", conversationId: "chat" };
	const draw = () =>
		render(() =>
			ContextDialog({
				scope,
				model: { provider: "provider", modelId: "model" },
				session,
				disabled: false,
				open: true,
				onOpenChange() {},
				onCloseAutoFocus() {},
				contentId: "consent",
				status: null,
			}),
		);
	const content = draw();
	assert.equal(authorized.length, 0);
	assert.equal(elements(content, Select)[0]?.props.value, root.rootId);
	assert.equal(elements(content, Select)[1]?.props.value, "whole");
	click(button(content, "Authorize model context"));
	await settle();
	assert.equal(authorized[0]?.rootId, root.rootId);
	assert.deepEqual(authorized[0]?.pathPrefixes, [""]);
	assert.equal(authorized[0]?.conversationId, "chat");
	const otherRoot = { ...root, workspaceId: "other", rootId: "other-root" };
	scope = { workspaceId: "other", conversationId: "other-chat" };
	roots = [otherRoot];
	projectQuery.data = { ...folder, workspaceId: "other", bindingId: "other-binding", root: otherRoot };
	click(button(draw(), "Authorize model context"));
	await settle();
	assert.equal(authorized[1]?.rootId, "other-root");
	assert.equal(authorized[1]?.workspaceId, "other");
	assert.equal(authorized[1]?.conversationId, "other-chat");
});
