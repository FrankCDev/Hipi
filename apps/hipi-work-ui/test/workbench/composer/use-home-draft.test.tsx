import assert from "node:assert/strict";
import type * as React from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useHomeDraft } from "../../../src/features/workbench/composer/use-home-draft.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	commits: [] as (() => void)[],
	changed: false,
}));
// Exercise the production hook and durable LocalState across committed navigation.
// This hook adapter does not establish native textarea, focus, or IME acceptance.
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useState: <T,>(initial: T | (() => T)) => {
		const index = hooks.cursor++;
		const cell = hooks.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
		hooks.cells[index] = cell;
		return [
			cell.value,
			(next: T | ((current: T) => T)) => {
				const value = typeof next === "function" ? (next as (current: T) => T)(cell.value as T) : next;
				hooks.changed ||= !Object.is(value, cell.value);
				cell.value = value;
			},
		];
	},
	useRef: <T,>(initial: T) => {
		const index = hooks.cursor++;
		const cell = hooks.cells[index] ?? { value: { current: initial } };
		hooks.cells[index] = cell;
		return cell.value;
	},
	useCallback: <T,>(callback: T, deps: React.DependencyList) => {
		const index = hooks.cursor++;
		const cell = hooks.cells[index];
		if (!cell || deps.some((value, position) => !Object.is(value, cell.deps?.[position])))
			hooks.cells[index] = { value: callback, deps };
		return hooks.cells[index]?.value;
	},
	useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
		const index = hooks.cursor++;
		const previous = hooks.cells[index];
		if (!previous || deps.some((value, position) => !Object.is(value, previous.deps?.[position])))
			hooks.commits.push(() => {
				previous?.cleanup?.();
				const cleanup = effect();
				hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			});
	},
}));

let local: LocalState;
let admission: Promise<void>;
let workspaceId: string;
let conversationId: string;
let focusRevision: number;

function Probe() {
	return useHomeDraft(local, workspaceId, conversationId, focusRevision);
}

function render() {
	for (let attempt = 0; attempt < 10; attempt++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const result = Probe();
		for (const effect of hooks.commits.splice(0)) effect();
		if (!hooks.changed) return result;
	}
	throw new Error("Home draft hook did not settle");
}

async function ready() {
	await vi.waitFor(() => {
		const result = render();
		assert.equal(result.failed, false);
		assert.equal(result.busy, false);
		assert.ok(result.inventory?.active);
	});
	return render();
}

function navigate(workspace: string, conversation = "") {
	render().cancel();
	workspaceId = workspace;
	conversationId = conversation;
	focusRevision++;
	return render();
}

beforeEach(() => {
	hooks.cells = [];
	hooks.commits = [];
	admission = Promise.resolve();
	workspaceId = "project-a";
	conversationId = "";
	focusRevision = 1;
	const saved = new Map<string, string>();
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("navigator", {
		locks: {
			request: async (_key: string, work: () => unknown) => {
				await admission;
				return work();
			},
		},
	});
	local = new LocalState("home-hook-store", {
		getItem: (key) => saved.get(key) ?? null,
		setItem: (key, value) => {
			saved.set(key, value);
		},
		key: (index) => [...saved.keys()][index] ?? null,
		get length() {
			return saved.size;
		},
	});
});

afterEach(() => {
	for (const cell of hooks.cells) cell.cleanup?.();
	vi.unstubAllGlobals();
});

test("first home is read-only until durable admission, not merely until the textarea can receive focus", async () => {
	const gate = Promise.withResolvers<void>();
	admission = gate.promise;
	const loading = render();
	assert.equal(loading.busy, true);
	assert.equal(loading.inventory, null);
	assert.equal(loading.busy || !loading.inventory?.active, true, "Workbench must keep the input read-only");
	gate.resolve();
	const editable = await ready();
	assert.equal(editable.busy || !editable.inventory?.active, false);
	editable.change("SIDEBAR_HOME_SHARED 中文");
	assert.equal(render().text, "SIDEBAR_HOME_SHARED 中文");
	assert.equal(local.storedValue(editable.inventory?.active?.sourceKey ?? "")?.value, "SIDEBAR_HOME_SHARED 中文");
});

test("home text and generation survive project switches, repeated New chat, brand and conversation round trips", async () => {
	render();
	const first = await ready();
	const active = first.inventory?.active;
	assert.ok(active);
	first.change("SIDEBAR_HOME_SHARED 中文");
	for (const destination of ["project-b", "project-b", ""]) {
		navigate(destination);
		const next = await ready();
		assert.equal(next.text, "SIDEBAR_HOME_SHARED 中文");
		assert.deepEqual(next.inventory?.active, active);
	}
	for (const destination of ["", "project-a"]) {
		navigate(destination || "default", "existing");
		navigate(destination);
		const next = await ready();
		assert.equal(next.text, "SIDEBAR_HOME_SHARED 中文");
		assert.deepEqual(next.inventory?.active, active);
	}
	assert.equal(local.storedValue("command.catalog"), null, "navigation never starts a command");
});

test("typing before delayed refresh admission is accepted from the latest durable source", async () => {
	render();
	const first = await ready();
	first.change("Original 中文");
	const gate = Promise.withResolvers<void>();
	admission = gate.promise;
	const refreshing = first.refresh();
	first.change("Newer edit 中文");
	gate.resolve();
	await refreshing;
	assert.equal((await ready()).text, "Newer edit 中文");
});

test("cancelled pending navigation cannot replace the shared source or its text", async () => {
	render();
	const first = await ready();
	first.change("Keep 中文");
	const active = first.inventory?.active;
	const gate = Promise.withResolvers<void>();
	admission = gate.promise;
	navigate("project-b");
	navigate("project-a", "existing");
	gate.resolve();
	navigate("");
	const next = await ready();
	assert.equal(next.text, "Keep 中文");
	assert.deepEqual(next.inventory?.active, active);
});
