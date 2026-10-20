import assert from "node:assert/strict";
import type * as React from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { CatalogSession, ProjectPinLifecycle } from "../../../src/features/workbench/catalog/session.ts";
import { PinnedConversations } from "../../../src/features/workbench/sidebar/pinned-conversations.tsx";
import type {
	PinLifecycle,
	PresentationSession,
} from "../../../src/features/workbench/sidebar/presentation-session.ts";

type Cell = { value?: unknown; deps?: React.DependencyList; cleanup?: () => void };
const fixture = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	effects: [] as (() => void)[],
	listener: undefined as ((event: PinLifecycle) => void) | undefined,
	projectListener: undefined as ((event: ProjectPinLifecycle) => void) | undefined,
	restoreProject: vi.fn(),
	restore: vi.fn(),
	cancel: vi.fn(),
}));
// Explicit hook/effect and DOM seam, not a mounted React or browser scheduling proof.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	const effect = (setup: React.EffectCallback, deps?: React.DependencyList) => {
		const index = fixture.cursor++;
		const old = fixture.cells[index];
		if (deps && old?.deps && deps.every((value, at) => Object.is(value, old.deps?.[at]))) return;
		fixture.effects.push(() => {
			old?.cleanup?.();
			const cleanup = setup();
			fixture.cells[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
		});
	};
	return {
		...actual,
		useId: () => "heading",
		useState: (value: unknown) => [value, vi.fn()],
		useRef: (value: unknown) => {
			const index = fixture.cursor++;
			fixture.cells[index] ??= { value: { current: value } };
			return fixture.cells[index].value;
		},
		useMemo: (create: () => unknown) => {
			const index = fixture.cursor++;
			fixture.cells[index] ??= { value: create() };
			return fixture.cells[index].value;
		},
		useEffect: effect,
		useLayoutEffect: effect,
		useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
	};
});
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => ({}) }));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: "en" }) }));
vi.mock("../../../src/features/workbench/catalog/use-pages.ts", () => ({
	useCatalogPages: () => ({ pages: [], items: [], isPending: false, isError: true }),
}));
vi.mock("../../../src/features/workbench/sidebar/pin-focus-recovery.ts", () => ({
	navigationFocusSettled: () => false,
	PinFocusRecovery: class {
		restore = fixture.restore;
		restoreProject = fixture.restoreProject;
		cancel = fixture.cancel;
	},
}));
class ElementStub extends EventTarget {
	isConnected = true;
	id = "trigger";
	dataset: Record<string, string> = { workspaceId: "project", conversationId: "chat" };
	hasAttribute(name: string) {
		return name === "data-pinned-project" && !!this.dataset.projectId;
	}
	row: ElementStub = this;
	menu = false;
	contains(target: unknown) {
		return target === this || target === trigger;
	}
	closest(selector: string) {
		if (selector === '[role="menu"]') return this.menu ? this : null;
		return this.row;
	}
	querySelectorAll() {
		return [trigger];
	}
	getAttribute() {
		return "trigger";
	}
	focus() {}
}
let trigger: ElementStub;
let body: ElementStub;
let documentStub: EventTarget & { activeElement: ElementStub; body: ElementStub; querySelector: () => ElementStub };
let windowStub: EventTarget;
const input = {
	workspaceId: "project",
	conversationId: "chat",
	pinned: false,
	expectedPresentationRevision: 1,
	requestId: "unpin",
};
const emit = (phase: "initiated" | "confirmed") =>
	fixture.listener?.(
		phase === "confirmed"
			? { phase, input, result: { workspaceId: "project", conversationId: "chat", pinned: false, revision: 2 } }
			: { phase, input },
	);
const presentation = {
	subscribePinLifecycle: (listener: (event: PinLifecycle) => void) => {
		fixture.listener = listener;
		return () => {
			fixture.listener = undefined;
		};
	},
	subscribe: vi.fn(),
	getSnapshot: () => ({}),
} as unknown as PresentationSession;
function render(revision = 0, collapsed = false, mixed = false) {
	fixture.cursor = 0;
	const element = PinnedConversations({
		catalog: {
			subscribeProjectPinLifecycle: (listener: (event: ProjectPinLifecycle) => void) => {
				fixture.projectListener = listener;
				return () => {
					fixture.projectListener = undefined;
				};
			},
		} as CatalogSession,
		mixed,
		presentation,
		onSelect: vi.fn(),
		navigationRevision: revision,
		collapsed,
	});
	for (const effect of fixture.effects.splice(0)) effect();
	assert.ok(element);
	return element.props as { onFocusCapture: (event: { target: ElementStub }) => void };
}
function remove(revision = 0) {
	trigger.isConnected = false;
	documentStub.activeElement = body;
	render(revision);
}
function dispatch(kind: string, target?: ElementStub) {
	const event = new Event(kind);
	if (target) Object.defineProperty(event, "target", { value: target });
	if (kind === "focusout") Object.defineProperty(event, "relatedTarget", { value: null });
	documentStub.dispatchEvent(event);
}
beforeEach(() => {
	fixture.cells = [];
	fixture.effects = [];
	vi.clearAllMocks();
	trigger = new ElementStub();
	body = new ElementStub();
	documentStub = Object.assign(new EventTarget(), {
		activeElement: trigger,
		body,
		querySelector: () => new ElementStub(),
	});
	windowStub = new EventTarget();
	vi.stubGlobal("Element", ElementStub);
	vi.stubGlobal("document", documentStub);
	vi.stubGlobal("window", windowStub);
	render().onFocusCapture({ target: trigger });
});
afterEach(() => {
	for (const cell of fixture.cells) cell.cleanup?.();
	vi.unstubAllGlobals();
});
test("only the exact locally initiated confirmed unpin may wait for its missing canonical row", () => {
	emit("initiated");
	emit("confirmed");
	remove();
	assert.equal(fixture.restore.mock.calls.length, 1);
	assert.equal(fixture.restore.mock.calls[0]?.[3], true);
});
test.each(["pointerdown", "keydown", "focusin", "focusout", "window-blur", "navigation"])(
	"new %s intent before row removal retires delayed focus permission",
	(kind) => {
		emit("initiated");
		if (kind === "navigation") render(1);
		else if (kind === "window-blur") windowStub.dispatchEvent(new Event("blur"));
		else dispatch(kind, kind === "focusout" ? trigger : body);
		emit("confirmed");
		remove(kind === "navigation" ? 1 : 0);
		assert.equal(fixture.restore.mock.calls.length, 0);
	},
);
test("a stale remembered row cannot initiate focus ownership after focus already left", () => {
	documentStub.activeElement = body;
	emit("initiated");
	emit("confirmed");
	remove();
	assert.equal(fixture.restore.mock.calls.length, 0);
});
test("the exact owned portal menu may initiate and return focus without losing its ticket", () => {
	const menu = new ElementStub();
	menu.menu = true;
	menu.row = menu;
	menu.contains = () => false;
	documentStub.activeElement = menu;
	emit("initiated");
	documentStub.activeElement = trigger;
	dispatch("focusin", trigger);
	emit("confirmed");
	remove();
	assert.equal(fixture.restore.mock.calls[0]?.[3], true);
});

function projectEvent(phase: "initiated" | "confirmed") {
	const input = { requestId: "project-unpin", projectId: "logical", pinned: false, expectedPresentationRevision: 1 };
	fixture.projectListener?.(
		phase === "confirmed"
			? { phase, input, result: { projectId: "logical", pinned: false, revision: 2 } }
			: { phase, input },
	);
}
test("project unpin restoration uses logical identity only after exact local initiation and confirmation", () => {
	trigger.dataset = { projectId: "logical", workspaceId: "adapter" };
	render(0, false, true).onFocusCapture({ target: trigger });
	projectEvent("initiated");
	projectEvent("confirmed");
	trigger.isConnected = false;
	documentStub.activeElement = body;
	render(0, false, true);
	assert.equal(fixture.restore.mock.calls.length, 0);
	assert.equal(fixture.restoreProject.mock.calls[0]?.[0], "logical");
	assert.equal(fixture.restoreProject.mock.calls[0]?.[3], true);
});
test("restored project confirmation cannot invent local focus intent", () => {
	trigger.dataset = { projectId: "logical", workspaceId: "adapter" };
	render(0, false, true).onFocusCapture({ target: trigger });
	projectEvent("confirmed");
	trigger.isConnected = false;
	documentStub.activeElement = body;
	render(0, false, true);
	assert.equal(fixture.restoreProject.mock.calls[0]?.[3], false);
});
test("new outside intent cancels project unpin delayed restoration", () => {
	trigger.dataset = { projectId: "logical", workspaceId: "adapter" };
	render(0, false, true).onFocusCapture({ target: trigger });
	projectEvent("initiated");
	dispatch("pointerdown", body);
	projectEvent("confirmed");
	trigger.isConnected = false;
	documentStub.activeElement = body;
	render(0, false, true);
	assert.equal(fixture.restoreProject.mock.calls.length, 0);
});
