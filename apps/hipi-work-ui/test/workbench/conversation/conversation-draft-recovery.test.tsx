import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useConversation } from "../../../src/features/workbench/conversation/use-conversation.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const lifecycle = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	commits: [] as (() => void)[],
	changed: false,
}));
// Retain the same production hook state across renders and commit effect lifecycles.
// This is not a DOM renderer; native textarea/focus acceptance is a separate gate.
vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useState: <T,>(initial: T | (() => T)) => {
		const index = lifecycle.cursor++;
		const cell = lifecycle.cells[index] ?? { value: typeof initial === "function" ? (initial as () => T)() : initial };
		lifecycle.cells[index] = cell;
		return [
			cell.value,
			(next: T | ((current: T) => T)) => {
				const value = typeof next === "function" ? (next as (current: T) => T)(cell.value as T) : next;
				if (!Object.is(value, cell.value)) lifecycle.changed = true;
				cell.value = value;
			},
		];
	},
	useRef: <T,>(initial: T) => {
		const index = lifecycle.cursor++;
		const cell = lifecycle.cells[index] ?? { value: { current: initial } };
		lifecycle.cells[index] = cell;
		return cell.value;
	},
	useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
		const index = lifecycle.cursor++;
		const previous = lifecycle.cells[index];
		if (!previous || deps.some((value, position) => !Object.is(value, previous.deps?.[position])))
			lifecycle.commits.push(() => {
				previous?.cleanup?.();
				const cleanup = effect();
				lifecycle.cells[index] = {
					value: undefined,
					deps,
					cleanup: typeof cleanup === "function" ? cleanup : undefined,
				};
			});
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => cache,
	useQuery: () => ({ data: undefined, isError: false }),
	useMutation: () => ({ isPending: false, mutate }),
}));
vi.mock("../../../src/app/client-provider.tsx", () => ({
	useLocalState: () => local,
	useAppClient: () => client,
}));
vi.mock("../../../src/features/workbench/conversation/use-observation.ts", () => ({
	useObservation: () => observation,
}));
const call = vi.fn();
const mutate = vi.fn();
const client = { call };
const cache = { invalidateQueries: vi.fn() };
const observation = { connection: "connected", snapshot: undefined, pause: vi.fn(), reconnect: vi.fn() };
const conversation: Conversation = {
	workspaceId: "project",
	conversationId: "created",
	title: "Created chat",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const key = "draft.project.created";
let local = new LocalState();
function Probe({ revision }: { revision?: string }) {
	return useConversation(conversation, revision);
}
function render(revision?: string, commit = true) {
	for (let attempt = 0; attempt < 5; attempt++) {
		lifecycle.cursor = 0;
		lifecycle.changed = false;
		const controller = Probe({ revision });
		if (!commit) return controller;
		for (const effect of lifecycle.commits.splice(0)) effect();
		if (!lifecycle.changed) return controller;
	}
	throw new Error("Hook did not settle");
}
beforeEach(() => {
	local = new LocalState();
	lifecycle.cells = [];
	lifecycle.commits = [];
	vi.clearAllMocks();
});
afterEach(() => {
	for (const cell of lifecycle.cells) cell.cleanup?.();
});

test("a combined draft reaches the same mounted conversation owner without replacing observation or submitting", () => {
	local.write(key, "Newer target draft");
	const initial = render();
	assert.equal(initial.draft, "Newer target draft");
	const composed = "Newer target draft\n\n---\n\n  Original unsent text\n";
	local.persistValue({ kind: "value", key, value: composed, revision: "combined-revision" });
	assert.equal(render().draft, "Newer target draft", "storage changes alone must not replace an active draft");
	const recovered = render("combined-revision");
	assert.equal(recovered.draft, composed);
	assert.equal(recovered.observation, initial.observation);
	assert.equal(recovered.composing, initial.composing);
	recovered.setDraft(`${recovered.draft}Later edit`);
	assert.equal(render("combined-revision").draft, `${composed}Later edit`);
	assert.equal(local.read(key), `${composed}Later edit`);
	assert.equal(call.mock.calls.length, 0);
	assert.equal(mutate.mock.calls.length, 0);
});

test("typing after the combined snapshot wins over a delayed recovery effect", () => {
	local.write(key, "Target draft");
	const mounted = render();
	local.persistValue({ kind: "value", key, value: "Target draft\n\n---\n\nOriginal", revision: "combined" });
	render("combined", false);
	mounted.setDraft("Even newer explicit edit");
	for (const effect of lifecycle.commits.splice(0)) effect();
	assert.equal(render("combined").draft, "Even newer explicit edit");
	assert.equal(local.read(key), "Even newer explicit edit");
	assert.equal(call.mock.calls.length, 0);
	assert.equal(mutate.mock.calls.length, 0);
});

test("a foreign draft revision cannot refresh this conversation", () => {
	local.write(key, "Keep selected chat");
	render();
	local.persistValue({ kind: "value", key: "draft.project.other", value: "Foreign combined", revision: "foreign" });
	assert.equal(render("foreign").draft, "Keep selected chat");
	assert.equal(local.read(key), "Keep selected chat");
});
