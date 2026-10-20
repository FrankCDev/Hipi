import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";
import {
	mergeOrder,
	SidebarLayoutSession,
	type SidebarSection,
} from "../src/features/workbench/sidebar-layout-session.ts";

const key = "sidebar.layout";
const storageKey = `hipi.work.local.v1.store.value.${key}`;
const defaultSections = ["pinned", "projects", "recent"];

class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
	failWrite = false;
	writes = 0;
	get length() {
		return this.values.size;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		if (this.failWrite) throw new Error("Storage unavailable");
		this.values.set(key, value);
		this.writes++;
	}
}

function fixture(storage = new MemoryStorage(), storeId = "store") {
	let queue = Promise.resolve<unknown>(undefined);
	vi.stubGlobal("navigator", {
		locks: {
			request: (_key: string, work: () => unknown) => {
				const next = queue.then(work);
				queue = next.catch(() => undefined);
				return next;
			},
		},
	});
	const local = new LocalState(storeId, storage);
	return { storage, local, session: new SidebarLayoutSession(local) };
}

function savedValue(local: LocalState) {
	const raw = local.storedValue(key)?.value;
	assert.ok(raw);
	return JSON.parse(raw);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("default order is read-only and restored moves remain scoped to the browser store", async () => {
	const { storage, local, session } = fixture();
	assert.deepEqual(session.getSnapshot().sections, defaultSections);
	assert.deepEqual(session.orderedProjects(["two", "one"]), ["two", "one"]);
	assert.equal(session.getSnapshot().revision, 0);
	assert.equal(storage.writes, 0);
	local.write("draft.w.c", "Keep this draft");
	local.write("workspace", "selected");
	local.write("conversation", "conversation");
	local.navigation = { workspaces: [], conversations: [] };
	assert.equal(await session.moveSection("recent", "pinned", 0), true);
	assert.equal(await session.moveProject("two", "one", ["one", "two"], 1), true);
	const restored = new SidebarLayoutSession(new LocalState("store", storage));
	assert.deepEqual(restored.getSnapshot().sections, ["recent", "pinned", "projects"]);
	assert.deepEqual(restored.orderedProjects(["one", "two"]), ["two", "one"]);
	assert.equal(restored.getSnapshot().revision, 2);
	const foreign = new SidebarLayoutSession(new LocalState("foreign", storage));
	assert.deepEqual(foreign.getSnapshot().sections, defaultSections);
	assert.deepEqual(foreign.getSnapshot().projects, []);
	assert.equal(local.read("draft.w.c"), "Keep this draft");
	assert.equal(local.read("workspace"), "selected");
	assert.equal(local.read("conversation"), "conversation");
	assert.deepEqual(local.navigation, { workspaces: [], conversations: [] });
	const durableKeys = [...storage.values.keys()].filter((key) => key.endsWith(".sidebar.layout"));
	assert.deepEqual(durableKeys, [storageKey]);
	assert.deepEqual(savedValue(local), {
		version: 1,
		sections: ["recent", "pinned", "projects"],
		projects: ["two", "one"],
		revision: 2,
	});
});

test("bounded navigation windows never prune stored identities and null means the full stored-known end", async () => {
	const { local, session } = fixture();
	assert.equal(await session.moveProject("four", null, ["one", "two", "three", "four"], 0), true);
	assert.equal(await session.moveProject("one", null, ["one", "two"], 1), true);
	assert.deepEqual(session.getSnapshot().projects, ["two", "three", "four", "one"]);
	assert.deepEqual(session.orderedProjects(["one", "two"]), ["two", "one"]);
	assert.equal(await session.moveProject("five", "two", ["two", "five"], 2), true);
	assert.deepEqual(savedValue(local).projects, ["five", "two", "three", "four", "one"]);
	assert.deepEqual(session.orderedProjects(["three", "one", "future"]), ["three", "one", "future"]);
	assert.deepEqual(mergeOrder(["unloaded", "one"], ["one", "new", "new"]), ["unloaded", "one", "new"]);
});

test("new orders are published only after durable write and subscribers cannot alter snapshots", async () => {
	const { storage, session } = fixture();
	const observed: number[] = [];
	const unsubscribe = session.subscribe(() => {
		const current = session.getSnapshot();
		if (current.revision > 0) {
			assert.ok(storage.getItem(storageKey));
			observed.push(current.revision);
		}
		assert.equal(Object.isFrozen(current), true);
		assert.equal(Object.isFrozen(current.sections), true);
		assert.equal(Object.isFrozen(current.projects), true);
	});
	await session.moveSection("projects", "pinned", 0);
	assert.ok(observed.includes(1));
	unsubscribe();
	const count = observed.length;
	await session.moveSection("projects", null, 1);
	assert.equal(observed.length, count);
});

test("a visible row can move before a retained canonical successor that is not currently loaded", async () => {
	const { session } = fixture();
	await session.moveProject("four", null, ["one", "two", "three", "four"], 0);
	assert.equal(await session.moveProject("one", "three", ["one", "two"], 1), true);
	assert.deepEqual(session.getSnapshot().projects, ["two", "one", "three", "four"]);
	assert.deepEqual(session.orderedProjects(["one", "two"]), ["two", "one"]);
});

test("failed writes retain captured intent without publishing a success and retry preserves that intent", async () => {
	const { storage, local, session } = fixture();
	const known = ["one", "two"];
	storage.failWrite = true;
	assert.equal(await session.moveProject("two", "one", known, 0), false);
	known.reverse();
	known.push("later");
	assert.deepEqual(session.getSnapshot().projects, []);
	assert.equal(session.getSnapshot().revision, 0);
	assert.equal(session.getSnapshot().failed, true);
	assert.deepEqual(session.getSnapshot().pending, {
		kind: "project",
		moved: "two",
		before: "one",
		knownIds: ["one", "two"],
		expectedRevision: 0,
	});
	assert.equal(local.read(key), null);
	assert.equal(storage.getItem(storageKey), null);
	assert.equal(await session.moveSection("recent", "pinned", 0), false, "a new action cannot replace a failed one");
	storage.failWrite = false;
	assert.equal(await session.refresh(), true);
	assert.ok(session.getSnapshot().pending, "refresh reads but never retries a failed write");
	assert.equal(session.getSnapshot().failed, true, "a readable record does not acknowledge an unsaved action");
	assert.equal(storage.writes, 0);
	assert.equal(await session.retry(), true);
	assert.deepEqual(session.getSnapshot().projects, ["two", "one"]);
	assert.equal(session.getSnapshot().pending, null);
	assert.equal(session.getSnapshot().failed, false);
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), false);
});

test("stale revisions refresh durable truth and reject a drop rather than clobber another owner", async () => {
	const { storage, local, session } = fixture();
	const other = new SidebarLayoutSession(new LocalState("store", storage));
	assert.equal(await session.moveSection("recent", "pinned", 0), true);
	assert.equal(await other.moveProject("two", "one", ["one", "two"], 0), false);
	assert.deepEqual(other.getSnapshot().sections, ["recent", "pinned", "projects"]);
	assert.equal(other.getSnapshot().revision, 1);
	assert.equal(other.getSnapshot().stale, true);
	assert.equal(other.getSnapshot().pending, null);
	assert.deepEqual(savedValue(local).projects, []);
	assert.equal(await other.moveProject("two", "one", ["one", "two"], 1), true);
	assert.equal(await session.refresh(), true);
	assert.deepEqual(session.getSnapshot().projects, ["two", "one"]);
	assert.equal(session.getSnapshot().revision, 2);
});

test("retry of a failed write cannot rebase its old intent over a newer durable layout", async () => {
	const { storage, session } = fixture();
	const other = new SidebarLayoutSession(new LocalState("store", storage));
	storage.failWrite = true;
	await session.moveSection("recent", "pinned", 0);
	storage.failWrite = false;
	await other.moveSection("projects", "pinned", 0);
	assert.equal(await session.retry(), false);
	assert.deepEqual(session.getSnapshot().sections, ["projects", "pinned", "recent"]);
	assert.equal(session.getSnapshot().stale, true);
	assert.equal(session.getSnapshot().pending, null);
	assert.equal(storage.writes, 1);
});

test("simultaneous store owners admit only the first action at one expected revision", async () => {
	const { storage, session } = fixture();
	const other = new SidebarLayoutSession(new LocalState("store", storage));
	assert.deepEqual(
		await Promise.all([session.moveSection("recent", "pinned", 0), other.moveProject("two", "one", ["one", "two"], 0)]),
		[true, false],
	);
	assert.equal(storage.writes, 1);
	assert.equal(other.getSnapshot().stale, true);
});

test("queued project moves snapshot known identities before admission", async () => {
	const { local, session } = fixture();
	const gate = Promise.withResolvers<void>();
	const admission = local.withAdmission.bind(local);
	local.withAdmission = async (key, work) => {
		await gate.promise;
		return admission(key, work);
	};
	const known = ["one", "two"];
	const running = session.moveProject("two", "one", known, 0);
	known.splice(0, known.length, "other", "later");
	gate.resolve();
	assert.equal(await running, true);
	assert.deepEqual(session.getSnapshot().projects, ["two", "one"]);
});

test("disposal, timeout, and a released connection cannot write from a queued admission", async () => {
	vi.useFakeTimers();
	for (const stop of ["dispose", "timeout", "connection"] as const) {
		const { storage, local, session } = fixture();
		const gate = Promise.withResolvers<void>();
		const admission = local.withAdmission.bind(local);
		local.withAdmission = async (key, work) => {
			await gate.promise;
			return admission(key, work);
		};
		const running = session.moveSection("recent", "pinned", 0);
		if (stop === "dispose") {
			session.dispose();
			session.activate();
			assert.equal(await running, false);
		} else if (stop === "timeout") {
			await vi.advanceTimersByTimeAsync(15000);
			assert.equal(await running, false);
		} else local.deactivate();
		gate.resolve();
		assert.equal(await running, false);
		await Promise.resolve();
		assert.equal(storage.writes, 0);
		assert.deepEqual(session.getSnapshot().sections, defaultSections);
		assert.equal(session.getSnapshot().busy, false);
		session.dispose();
	}
});

test("an incompatible record is preserved and refresh can recover after an external repair", async () => {
	const { storage, local } = fixture();
	const raw = JSON.stringify({ version: 2, sections: defaultSections, projects: [], revision: 1 });
	assert.equal(local.write(key, raw), true);
	const session = new SidebarLayoutSession(local);
	assert.equal(session.getSnapshot().incompatible, true);
	assert.equal(await session.moveSection("recent", "pinned", 0), false);
	assert.equal(await session.retry(), false);
	assert.equal(new LocalState("store", storage).read(key), raw);
	const valid = JSON.stringify({ version: 1, sections: defaultSections, projects: ["unloaded"], revision: 4 });
	assert.equal(local.write(key, valid), true);
	assert.equal(await session.refresh(), true);
	assert.equal(session.getSnapshot().incompatible, false);
	assert.equal(session.getSnapshot().revision, 4);
	assert.equal(await session.moveSection("recent", "pinned", 4), true);
	assert.deepEqual(session.getSnapshot().projects, ["unloaded"]);
});

test.each([
	{ sections: ["pinned", "pinned", "recent"] },
	{ sections: ["pinned", "projects"] },
	{ sections: ["pinned", "projects", "unknown"] },
	{ projects: ["one", "one"] },
	{ projects: ["path/escape"] },
	{ projects: ["x".repeat(129)] },
	{ projects: Array.from({ length: 1025 }, (_, index) => `project-${index}`) },
	{ projects: Array.from({ length: 300 }, (_, index) => `${index}-${"x".repeat(120)}`) },
	{ revision: 0 },
	{ revision: 0.5 },
	{ revision: Number.MAX_SAFE_INTEGER + 1 },
	{ extra: "unrecognized" },
])("malformed or over-capacity layouts are never overwritten: %j", async (invalid) => {
	const local = new LocalState();
	const value = JSON.stringify({ version: 1, sections: defaultSections, projects: [], revision: 1, ...invalid });
	local.write(key, value);
	const session = new SidebarLayoutSession(local);
	assert.equal(session.getSnapshot().incompatible, true);
	assert.equal(await session.moveSection("recent", "pinned", 1), false);
	assert.equal(local.read(key), value);
});

test("capacity exhaustion preserves unknown identities instead of pruning to make a drop fit", async () => {
	const { local, session } = fixture();
	const known = Array.from({ length: 1024 }, (_, index) => `project-${index}`);
	assert.equal(await session.moveProject("project-1", "project-0", known, 0), true);
	const before = local.read(key);
	assert.equal(await session.moveProject("new", null, ["new"], 1), false);
	assert.equal(local.read(key), before);
	assert.equal(session.getSnapshot().projects.length, 1024);
	assert.equal(session.getSnapshot().failed, true);
	assert.equal(await session.moveProject("unknown", null, ["new"], 1), false);
	assert.equal(await session.moveProject("project-0", "missing", ["project-0"], 1), false);
	assert.equal(local.read(key), before);
});

test("corrupt outer storage, missing browser locks, and revoked storage never publish a successful order", async () => {
	for (const failure of ["corrupt", "locks", "storage"] as const) {
		const { storage, session } = fixture();
		if (failure === "corrupt") storage.values.set(storageKey, "not-json");
		else if (failure === "locks") vi.stubGlobal("navigator", {});
		else
			storage.getItem = () => {
				throw new Error("Storage denied");
			};
		assert.equal(await session.moveSection("recent", "pinned", 0), false);
		assert.equal(session.getSnapshot().failed, true);
		assert.equal(session.getSnapshot().revision, 0);
		assert.deepEqual(session.getSnapshot().sections, defaultSections);
		assert.equal(storage.writes, 0);
	}
});

test("identity moves do not write or advance revisions, and invalid section identities are rejected", async () => {
	const { storage, session } = fixture();
	assert.equal(await session.moveSection("pinned", "pinned", 0), true);
	assert.equal(await session.moveSection("recent", null, 0), true);
	assert.equal(storage.writes, 0);
	assert.equal(await session.moveSection("invalid" as SidebarSection, null, 0), false);
	assert.equal(storage.writes, 0);
	assert.equal(session.getSnapshot().pending, null);
});

test("revision exhaustion rejects a changed order without rolling its fence back", async () => {
	const { local } = fixture();
	const value = JSON.stringify({
		version: 1,
		sections: defaultSections,
		projects: [],
		revision: Number.MAX_SAFE_INTEGER,
	});
	local.write(key, value);
	const session = new SidebarLayoutSession(local);
	assert.equal(await session.moveSection("recent", "pinned", Number.MAX_SAFE_INTEGER), false);
	assert.equal(local.read(key), value);
	assert.equal(session.getSnapshot().failed, true);
	assert.equal(session.getSnapshot().revision, Number.MAX_SAFE_INTEGER);
});
