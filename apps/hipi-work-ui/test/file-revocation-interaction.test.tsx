import assert from "node:assert/strict";
import { type FileRoot, FileServiceError } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { FileAuthority } from "../src/app/file-client.ts";
import { Button } from "../src/components/ui/button.tsx";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { FileWorkbench } from "../src/features/files/file-workbench.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0, commits: [] as (() => void)[], changed: false }));
// Exercises the production FileWorkbench callbacks and owner effects. This
// bounded hook adapter does not claim native modal focus or DOM reachability.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const changed = (previous: React.DependencyList | undefined, next: React.DependencyList) =>
		!previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T | ((value: T) => T)) => {
					const value = typeof next === "function" ? (next as (value: T) => T)(cell.value as T) : next;
					if (!Object.is(cell.value, value)) hooks.changed = true;
					cell.value = value;
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
			const previous = hooks.cells[index];
			if (!previous || changed(previous.deps, deps)) hooks.cells[index] = { value: create(), deps };
			return hooks.cells[index]?.value;
		},
		useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const previous = hooks.cells[index];
			if (!previous || changed(previous.deps, deps))
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => cache,
	useQuery: () => ({ data: roots, isPending: false, isError: false, isFetching: false, refetch: async () => {} }),
}));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../src/app/client-provider.tsx", () => ({ useFiles: () => port }));

const cache = { invalidateQueries: vi.fn(async () => {}) };
const root: FileRoot = { workspaceId: "workspace", rootId: "root", writable: true };
let roots: FileRoot[] = [];
let port: { files: FileClient; fileAuthority: FileAuthority };
let session: FileWorkspaceSession;
let workspaceId = "workspace";
const owners: FileWorkspaceSession[] = [];
function client(): FileClient {
	return {
		listRoots: async () => roots,
		list: async () => ({ entries: [], nextCursor: null }),
		readText: async () => ({ text: "original", revision: "a".repeat(64), bytes: 8, encoding: "utf-8" }),
		saveText: async () => {
			throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
		},
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
	};
}
function owner(files = port.files) {
	const value = new FileWorkspaceSession(files);
	value.setWorkspace("workspace");
	owners.push(value);
	return value;
}
async function open(path: string, rootId = "root", workspace = "workspace") {
	await session.open({ workspaceId: workspace, rootId, path }, true, { pinned: true });
	const tab = session.snapshot().tabs.find((item) => item.id === session.snapshot().activeId);
	assert.ok(tab?.kind === "editor");
	return tab;
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
function drive() {
	for (let attempt = 0; attempt < 5; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const content = FileWorkbench({ workspaceId, session });
		for (const commit of hooks.commits.splice(0)) commit();
		if (hooks.changed) continue;
		const dialogs = elements(content, Dialog);
		const access = dialogs[0];
		const decision = dialogs[1];
		assert.ok(access && decision);
		const button = (node: React.ReactNode, label: string) => {
			const found = elements(node, Button).find((item) => item.props.children === label);
			assert.ok(found, `Missing production button: ${label}`);
			return found;
		};
		return {
			decision,
			revoke: () => button(access.props.children, "Revoke folder"),
			confirm: () => button(decision.props.children, "Discard and continue"),
			cancel: () => button(decision.props.children, "Keep editing"),
			paths: elements(decision.props.children, "li").map((item) => item.props.children),
		};
	}
	throw new Error("FileWorkbench effects did not settle");
}
function press(button: React.ReactElement<React.ComponentProps<typeof Button>>) {
	assert.ok(button.props.onClick);
	Reflect.apply(button.props.onClick, undefined, []);
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	hooks.cells = [];
	hooks.commits = [];
	roots = [root];
	workspaceId = "workspace";
	port = { files: client(), fileAuthority: { chooseRoot: vi.fn(async () => {}), revokeRoot: vi.fn(async () => {}) } };
	session = owner();
});
afterEach(() => {
	for (const cell of hooks.cells) cell?.cleanup?.();
	for (const value of owners.splice(0)) value.dispose();
	vi.useRealTimers();
});

test("new protected same-root owner refreshes the actual confirmation; unchanged review commits once", async () => {
	const first = await open("first.txt");
	first.editor.edit("first draft");
	const otherRoot = await open("other.txt", "other");
	otherRoot.editor.edit("unrelated draft");
	press(drive().revoke());
	const original = drive();
	assert.equal(original.decision.props.open, true);
	assert.deepEqual(original.paths, ["first.txt"]);
	const staleConfirm = original.confirm();
	const second = await open("second.txt");
	second.editor.edit("new protected work");
	press(staleConfirm);
	assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 0);
	assert.equal(first.editor.snapshot().document?.text, "first draft");
	assert.equal(second.editor.snapshot().document?.text, "new protected work");
	assert.deepEqual(drive().paths, ["first.txt", "second.txt"]);
	press(staleConfirm);
	assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 0);
	const reviewed = drive().confirm();
	press(reviewed);
	press(reviewed);
	assert.deepEqual(vi.mocked(port.fileAuthority.revokeRoot).mock.calls, [["workspace", "root"]]);
	assert.deepEqual(
		session.snapshot().tabs.map((tab) => tab.id),
		[otherRoot.id],
	);
	assert.equal(otherRoot.editor.snapshot().document?.text, "unrelated draft");
	assert.equal(drive().decision.props.open, false);
});
test.each(["edit", "unknown"] as const)(
	"changed protected owner (%s) cannot reuse the previous reviewed snapshot",
	async (change) => {
		const tab = await open("work.txt");
		tab.editor.edit("reviewed input");
		press(drive().revoke());
		const original = drive().confirm();
		if (change === "edit") tab.editor.edit("later input");
		else await tab.editor.save();
		const changed = tab.editor.snapshot();
		press(original);
		assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 0);
		assert.equal(tab.editor.snapshot(), changed);
		assert.equal(drive().decision.props.open, true);
		press(drive().confirm());
		assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 1);
	},
);
test("cancel invalidates an already captured confirm callback without discarding or revoking", async () => {
	const tab = await open("work.txt");
	tab.editor.edit("keep me");
	press(drive().revoke());
	const current = drive();
	const confirm = current.confirm();
	press(current.cancel());
	press(confirm);
	assert.equal(drive().decision.props.open, false);
	assert.equal(tab.editor.snapshot().document?.text, "keep me");
	assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 0);
});
test.each(["root", "workspace", "session", "connection", "unmount"] as const)(
	"retired %s cannot execute the old root confirmation",
	async (retirement) => {
		const tab = await open("work.txt");
		tab.editor.edit("keep me");
		const row = drive().revoke();
		press(row);
		const confirmation = drive().confirm();
		const originalAuthority = port.fileAuthority;
		if (retirement === "root") {
			roots = [];
			drive();
			// A replacement grant with the same display ID cannot revive its old row or decision.
			roots = [{ ...root }];
			drive();
		} else if (retirement === "workspace") {
			workspaceId = "other";
			drive();
		} else if (retirement === "session") {
			session = owner();
			drive();
		} else if (retirement === "connection") {
			port = {
				files: client(),
				fileAuthority: { chooseRoot: vi.fn(async () => {}), revokeRoot: vi.fn(async () => {}) },
			};
			drive();
		} else for (const cell of hooks.cells) cell?.cleanup?.();
		press(confirmation);
		press(row);
		assert.equal(tab.editor.snapshot().document?.text, "keep me");
		assert.equal(vi.mocked(originalAuthority.revokeRoot).mock.calls.length, 0);
		assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 0);
	},
);
test("an unchanged clean-root request needs no discard prompt and repeated activation dispatches once", async () => {
	await open("clean.txt");
	const pending = Promise.withResolvers<void>();
	vi.mocked(port.fileAuthority.revokeRoot).mockImplementation(() => pending.promise);
	const row = drive().revoke();
	press(row);
	press(row);
	assert.equal(drive().decision.props.open, false);
	assert.equal(vi.mocked(port.fileAuthority.revokeRoot).mock.calls.length, 1);
	assert.equal(session.snapshot().tabs.length, 0);
	pending.resolve();
	await Promise.resolve();
	await Promise.resolve();
});
