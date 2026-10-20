import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { type BrowserStorage, LocalPersistence } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { SidebarDisclosureSession } from "../../../src/features/workbench/sidebar/disclosure-session.ts";
import type { SidebarSection } from "../../../src/features/workbench/sidebar/layout-session.ts";

const key = "sidebar.disclosure";
const storageKey = `hipi.work.local.v1.store.value.${key}`;
const expanded = { pinned: false, projects: false, recent: false };
const revisions = { pinned: 0, projects: 0, recent: 0 };

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

function fixture() {
	const storage = new MemoryStorage();
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
	const local = new LocalState("store", storage);
	return { storage, local, session: new SidebarDisclosureSession(local) };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("all sections default expanded without writing and reload remains isolated by store", async () => {
	const { storage, local, session } = fixture();
	assert.deepEqual(session.getSnapshot().collapsed, expanded);
	assert.deepEqual(session.getSnapshot().revisions, revisions);
	assert.equal(storage.writes, 0);
	local.write("draft.w.c", "Keep this draft");
	local.write("workspace", "workspace");
	local.write("conversation", "conversation");
	assert.equal(await session.setCollapsed("pinned", true), true);
	assert.equal(await session.setCollapsed("recent", true), true);
	const restored = new SidebarDisclosureSession(new LocalState("store", storage));
	assert.deepEqual(restored.getSnapshot().collapsed, { pinned: true, projects: false, recent: true });
	assert.deepEqual(restored.getSnapshot().revisions, { pinned: 1, projects: 0, recent: 1 });
	const foreign = new SidebarDisclosureSession(new LocalState("foreign", storage));
	assert.deepEqual(foreign.getSnapshot().collapsed, expanded);
	assert.equal(local.read("draft.w.c"), "Keep this draft");
	assert.equal(local.read("workspace"), "workspace");
	assert.equal(local.read("conversation"), "conversation");
	assert.equal(new LocalState("store", storage).read(key), local.read(key));
	assert.equal(Object.isFrozen(restored.getSnapshot()), true);
	assert.equal(Object.isFrozen(restored.getSnapshot().collapsed), true);
	assert.equal(Object.isFrozen(restored.getSnapshot().revisions), true);
});

test("disclosure preserves the ordering record including revisions and unloaded projects byte-for-byte", async () => {
	const { storage, local, session } = fixture();
	const layout = JSON.stringify({
		version: 1,
		sections: ["recent", "projects", "pinned"],
		projects: ["unloaded", "other-window", "visible"],
		revision: 42,
	});
	local.write("sidebar.layout", layout);
	const before = storage.getItem("hipi.work.local.v1.store.value.sidebar.layout");
	await session.setCollapsed("projects", true);
	await session.setCollapsed("pinned", true);
	await session.setCollapsed("projects", false);
	assert.equal(local.read("sidebar.layout"), layout);
	assert.equal(storage.getItem("hipi.work.local.v1.store.value.sidebar.layout"), before);
	assert.deepEqual(session.getSnapshot().collapsed, { pinned: true, projects: false, recent: false });
	assert.equal(new LocalState("store", storage).hasUnsavedWork(), false);
});

test("only durable values are published and subscription cleanup releases listeners", async () => {
	const { storage, session } = fixture();
	let published = 0;
	const unsubscribe = session.subscribe(() => {
		const snapshot = session.getSnapshot();
		if (snapshot.collapsed.projects) {
			const durable = new SidebarDisclosureSession(new LocalState("store", storage)).getSnapshot();
			assert.deepEqual(snapshot.collapsed, durable.collapsed);
			assert.deepEqual(snapshot.revisions, durable.revisions);
			published++;
		}
	});
	await session.setCollapsed("projects", true);
	assert.ok(published > 0);
	unsubscribe();
	const count = published;
	await session.setCollapsed("recent", true);
	assert.equal(published, count);
});

test("independent sections merge concurrent explicit sets from stale window caches", async () => {
	const { storage, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	assert.deepEqual(await Promise.all([session.setCollapsed("pinned", true), other.setCollapsed("projects", true)]), [
		true,
		true,
	]);
	assert.equal(storage.writes, 2);
	assert.deepEqual(other.getSnapshot().collapsed, { pinned: true, projects: true, recent: false });
	assert.equal(await session.refresh(), true);
	assert.deepEqual(session.getSnapshot().collapsed, other.getSnapshot().collapsed);
});

test("concurrent same-section setters cannot become two toggles or overwrite a newer intent", async () => {
	const { storage, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	assert.deepEqual(await Promise.all([session.setCollapsed("pinned", true), other.setCollapsed("pinned", true)]), [
		true,
		false,
	]);
	assert.equal(storage.writes, 1);
	assert.equal(other.getSnapshot().collapsed.pinned, true);
	assert.equal(other.getSnapshot().stale, true);
	assert.equal(other.getSnapshot().pending, null);
	assert.equal(await other.setCollapsed("pinned", false), true);
	assert.equal(other.getSnapshot().collapsed.pinned, false);
	assert.equal(other.getSnapshot().revisions.pinned, 2);
});

test("failed durability preserves exact intent and refresh does not silently replay or clear its error", async () => {
	const { storage, local, session } = fixture();
	storage.failWrite = true;
	assert.equal(await session.setCollapsed("projects", true), false);
	assert.deepEqual(session.getSnapshot().collapsed, expanded);
	assert.deepEqual(session.getSnapshot().revisions, revisions);
	assert.equal(session.getSnapshot().failed, true);
	const pending = session.getSnapshot().pending;
	assert.deepEqual(pending, { section: "projects", collapsed: true, expectedRevision: 0 });
	assert.equal(Object.isFrozen(pending), true);
	assert.equal(local.read(key), null);
	assert.equal(storage.getItem(storageKey), null);
	assert.equal(await session.setCollapsed("recent", true), false);
	storage.failWrite = false;
	assert.equal(await session.refresh(), true);
	assert.equal(session.getSnapshot().pending, pending);
	assert.equal(session.getSnapshot().failed, true);
	assert.equal(storage.writes, 0);
	assert.equal(await session.retry(), true);
	assert.equal(session.getSnapshot().collapsed.projects, true);
	assert.equal(session.getSnapshot().pending, null);
	assert.equal(session.getSnapshot().failed, false);
});

test("retry preserves another section's durable change rather than replacing a stale full snapshot", async () => {
	const { storage, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	storage.failWrite = true;
	await session.setCollapsed("projects", true);
	storage.failWrite = false;
	await other.setCollapsed("recent", true);
	assert.equal(await session.retry(), true);
	assert.deepEqual(session.getSnapshot().collapsed, { pinned: false, projects: true, recent: true });
	assert.deepEqual(session.getSnapshot().revisions, { pinned: 0, projects: 1, recent: 1 });
});

test("a newer explicit unchanged value fences an older failed opposite intent", async () => {
	const { storage, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	storage.failWrite = true;
	await session.setCollapsed("projects", true);
	storage.failWrite = false;
	assert.equal(await other.setCollapsed("projects", false), true);
	assert.equal(other.getSnapshot().revisions.projects, 1);
	assert.equal(await session.retry(), false);
	assert.equal(session.getSnapshot().collapsed.projects, false);
	assert.equal(session.getSnapshot().pending, null);
	assert.equal(session.getSnapshot().stale, true);
	assert.equal(storage.writes, 1);
});

test("same-section ABA changes invalidate retry even when the final value equals its original value", async () => {
	const { storage, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	storage.failWrite = true;
	await session.setCollapsed("projects", true);
	storage.failWrite = false;
	await other.setCollapsed("projects", true);
	await other.setCollapsed("projects", false);
	assert.equal(await session.refresh(), false);
	assert.equal(session.getSnapshot().pending, null);
	assert.equal(session.getSnapshot().stale, true);
	assert.equal(await session.retry(), true, "a retry without pending intent only refreshes");
	assert.equal(session.getSnapshot().collapsed.projects, false);
	assert.equal(storage.writes, 2);
});

test("delayed admission cannot overwrite another window's later same-section intent", async () => {
	const { storage, local, session } = fixture();
	const other = new SidebarDisclosureSession(new LocalState("store", storage));
	const gate = Promise.withResolvers<void>();
	const admission = local.withAdmission.bind(local);
	local.withAdmission = async (key, work) => {
		await gate.promise;
		return admission(key, work);
	};
	const queued = session.setCollapsed("recent", true);
	assert.equal(await other.setCollapsed("recent", false), true);
	gate.resolve();
	assert.equal(await queued, false);
	assert.equal(session.getSnapshot().collapsed.recent, false);
	assert.equal(session.getSnapshot().stale, true);
	assert.equal(storage.writes, 1);
});

test("disposal, timeout, and connection release prevent queued writes and late publication", async () => {
	vi.useFakeTimers();
	for (const stop of ["dispose", "timeout", "connection"] as const) {
		const { storage, local, session } = fixture();
		const gate = Promise.withResolvers<void>();
		const admission = local.withAdmission.bind(local);
		local.withAdmission = async (key, work) => {
			await gate.promise;
			return admission(key, work);
		};
		const queued = session.setCollapsed("pinned", true);
		if (stop === "dispose") {
			session.dispose();
			session.activate();
			assert.equal(await queued, false);
		} else if (stop === "timeout") {
			await vi.advanceTimersByTimeAsync(15000);
			assert.equal(await queued, false);
		} else local.deactivate();
		gate.resolve();
		assert.equal(await queued, false);
		await Promise.resolve();
		assert.equal(storage.writes, 0);
		assert.deepEqual(session.getSnapshot().collapsed, expanded);
		assert.equal(session.getSnapshot().busy, false);
		session.dispose();
	}
});

test("a released store lease and a disposed session cannot mutate durable disclosure", async () => {
	const { storage } = fixture();
	let active = true;
	const session = new SidebarDisclosureSession(new LocalState("store", storage, () => active));
	active = false;
	assert.equal(await session.setCollapsed("recent", true), false);
	assert.equal(session.getSnapshot().failed, true);
	assert.equal(storage.writes, 0);
	session.dispose();
	const before = session.getSnapshot();
	assert.equal(await session.setCollapsed("projects", true), false);
	assert.equal(await session.retry(), false);
	assert.equal(await session.refresh(), false);
	assert.equal(session.getSnapshot(), before);
});

test("corrupt outer storage, denied reads, missing locks, and unavailable storage never publish success", async () => {
	for (const failure of ["corrupt", "read", "locks", "unavailable"] as const) {
		const { storage, session: initial } = fixture();
		const session =
			failure === "unavailable" ? new SidebarDisclosureSession(new LocalState("store", undefined)) : initial;
		if (failure === "corrupt") storage.values.set(storageKey, "not-json");
		else if (failure === "read")
			storage.getItem = () => {
				throw new Error("Storage denied");
			};
		else if (failure === "locks") vi.stubGlobal("navigator", {});
		assert.equal(await session.setCollapsed("recent", true), false);
		assert.equal(session.getSnapshot().failed, true);
		assert.deepEqual(session.getSnapshot().collapsed, expanded);
		assert.equal(storage.writes, 0);
	}
});

test("unknown schemas are preserved and explicit refresh recovers after an external repair", async () => {
	const { storage, local } = fixture();
	const invalid = JSON.stringify({ version: 2, collapsed: expanded, revisions });
	local.write(key, invalid);
	const session = new SidebarDisclosureSession(new LocalState("store", storage));
	assert.equal(session.getSnapshot().incompatible, true);
	assert.equal(await session.setCollapsed("recent", true), false);
	assert.equal(await session.retry(), false);
	assert.equal(local.storedValue(key)?.value, invalid);
	const repaired = JSON.stringify({
		version: 1,
		collapsed: { ...expanded, pinned: true },
		revisions: { ...revisions, pinned: 4 },
	});
	local.write(key, repaired);
	assert.equal(await session.refresh(), true);
	assert.equal(session.getSnapshot().incompatible, false);
	assert.equal(session.getSnapshot().collapsed.pinned, true);
	assert.equal(await session.setCollapsed("recent", true), true);
	assert.equal(session.getSnapshot().revisions.pinned, 4);
});

test.each([
	{ version: 2 },
	{ collapsed: { pinned: false, projects: false } },
	{ collapsed: { ...expanded, unknown: false } },
	{ collapsed: { ...expanded, recent: "false" } },
	{ revisions: { pinned: 0, projects: 0 } },
	{ revisions: { ...revisions, unknown: 0 } },
	{ revisions: { ...revisions, recent: -1 } },
	{ revisions: { ...revisions, recent: 0.5 } },
	{ revisions: { ...revisions, recent: Number.MAX_SAFE_INTEGER + 1 } },
	{ extra: "unrecognized" },
])("malformed section records are preserved without applying any partial state: %j", async (invalid) => {
	const local = new LocalState();
	const value = JSON.stringify({ version: 1, collapsed: expanded, revisions, ...invalid });
	local.write(key, value);
	const session = new SidebarDisclosureSession(local);
	assert.equal(session.getSnapshot().incompatible, true);
	assert.deepEqual(session.getSnapshot().collapsed, expanded);
	assert.equal(await session.setCollapsed("pinned", true), false);
	assert.equal(local.read(key), value);
});

test("both the record parser and persistence boundary reject oversized disclosure data", async () => {
	const { storage, local } = fixture();
	const value = `${JSON.stringify({ version: 1, collapsed: expanded, revisions })}${" ".repeat(1024)}`;
	const persistence = new LocalPersistence("store", storage);
	assert.throws(() => persistence.save({ kind: "value", key, value }), /Invalid local state/);
	local.write(key, value);
	const session = new SidebarDisclosureSession(local);
	assert.equal(session.getSnapshot().incompatible, true);
	assert.equal(await session.setCollapsed("pinned", true), false);
	assert.equal(storage.writes, 0);
});

test("invalid setter inputs and revision exhaustion cannot create unbounded or malformed state", async () => {
	const { local, session } = fixture();
	assert.equal(await session.setCollapsed("unknown" as SidebarSection, true), false);
	// @ts-expect-error Untyped callers must not bypass the persisted boolean schema.
	assert.equal(await session.setCollapsed("pinned", "false"), false);
	assert.equal(local.read(key), null);
	const value = JSON.stringify({
		version: 1,
		collapsed: expanded,
		revisions: { ...revisions, pinned: Number.MAX_SAFE_INTEGER },
	});
	local.write(key, value);
	const exhausted = new SidebarDisclosureSession(local);
	assert.equal(await exhausted.setCollapsed("pinned", true), false);
	assert.equal(exhausted.getSnapshot().failed, true);
	assert.equal(exhausted.getSnapshot().pending, null);
	assert.equal(exhausted.getSnapshot().revisions.pinned, Number.MAX_SAFE_INTEGER);
	assert.equal(local.read(key), value);
});
