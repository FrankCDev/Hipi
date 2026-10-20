import assert from "node:assert/strict";
import { test } from "node:test";
import type { Submit } from "@hipi/work-runtime/contracts";
import type { BrowserStorage } from "../src/features/workbench/local-persistence.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

class MemoryStorage implements BrowserStorage {
	values = new Map<string, string>();
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
		this.values.set(key, value);
	}
}
const input: Submit = { workspaceId: "w", conversationId: "c", requestId: "r", text: "original" };

test("file dock ratio is a bounded store-scoped preference, not an editor or permission record", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store-a", storage);
	assert.equal(local.write("file-panel.ratio", "0.625000"), true);
	assert.equal(new LocalState("store-a", storage).read("file-panel.ratio"), "0.625000");
	assert.equal(new LocalState("store-b", storage).read("file-panel.ratio"), null);
	for (const invalid of ["-1", "1.001", "NaN", "Infinity", "1e-1", "0.1234567", " 0.5", ""])
		assert.equal(new LocalState("test", new MemoryStorage()).write("file-panel.ratio", invalid), false);
	assert.equal(local.hasUnsavedWork(), false);
});

test("new-chat model preference is bounded, store-scoped data rather than credentials", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store-a", storage);
	const value = JSON.stringify(["faux", "model-one"]);
	assert.equal(local.write("new-chat-model", value), true);
	assert.equal(new LocalState("store-a", storage).read("new-chat-model"), value);
	assert.equal(new LocalState("store-b", storage).read("new-chat-model"), null);
	for (const invalid of ['"model"', '["provider"]', '["","model"]', '{"apiKey":"not-a-preference"}']) {
		const other = new LocalState("other", new MemoryStorage());
		assert.equal(other.write("new-chat-model", invalid), false);
	}
	assert.equal(local.hasUnsavedWork(), false);
});

test("project expansion restores per store without changing drafts or pending submissions", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store-a", storage);
	assert.equal(local.write("workspace-expanded.one", "true"), true);
	assert.equal(local.write("workspace-expanded.two", "false"), true);
	assert.equal(local.hasUnsavedWork(), false);
	local.write("draft.w.c", "unsent draft");
	local.remember("w.c", input);
	const restored = new LocalState("store-a", storage);
	assert.equal(restored.read("workspace-expanded.one"), "true");
	assert.equal(restored.read("workspace-expanded.two"), "false");
	assert.equal(restored.read("draft.w.c"), "unsent draft");
	assert.deepEqual(restored.pending("w.c"), input);
	assert.equal(new LocalState("store-b", storage).read("workspace-expanded.one"), null);
	assert.equal(new LocalState(undefined, storage).read("workspace-expanded.one"), null);
});

test("corrupt project expansion is ignored and can be replaced without losing a draft", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("draft.w.c", "keep draft");
	const key = "hipi.work.local.v1.store.value.workspace-expanded.w";
	for (const value of [
		"broken-json",
		JSON.stringify({ version: 1, storeId: "store", kind: "value", key: "workspace-expanded.w", value: "yes" }),
	]) {
		storage.setItem(key, value);
		const restored = new LocalState("store", storage);
		assert.equal(restored.read("workspace-expanded.w"), null);
		assert.equal(restored.read("draft.w.c"), "keep draft");
		assert.equal(restored.write("workspace-expanded.w", "false"), true);
		assert.equal(new LocalState("store", storage).read("workspace-expanded.w"), "false");
	}
});

test("released stores cannot persist later project toggles", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("workspace-expanded.w", "true");
	local.deactivate();
	assert.equal(local.write("workspace-expanded.w", "false"), false);
	assert.equal(new LocalState("store", storage).read("workspace-expanded.w"), "true");
});

test("verified store restores original retry payload and later draft, while other store stays isolated", () => {
	const storage = new MemoryStorage();
	const first = new LocalState("store-a", storage);
	first.remember("w.c", input);
	first.write("draft.w.c", "later edit");
	first.write("workspace", "w");
	const restored = new LocalState("store-a", storage);
	assert.deepEqual(restored.pending("w.c"), input);
	assert.equal(restored.read("draft.w.c"), "later edit");
	assert.equal(restored.read("workspace"), "w");
	assert.equal(restored.hasUnsavedWork(), true);
	assert.equal(new LocalState("store-b", storage).pending("w.c"), null);
	assert.equal(new LocalState(undefined, storage).read("draft.w.c"), null);
});

test("confirmation survives reload and protects a newly authored identical draft", () => {
	const storage = new MemoryStorage();
	const first = new LocalState("store", storage);
	first.remember("w.c", input);
	first.confirmed("r");
	first.write("draft.w.c", input.text);
	const restored = new LocalState("store", storage);
	assert.equal(restored.isConfirmed("r"), true);
	assert.equal(restored.read("draft.w.c"), input.text);
	assert.throws(() => restored.remember("w.c", { ...input, text: "mutated" }));
	assert.deepEqual(restored.pending("w.c"), input);
});

test("corrupt, wrong-store, wrong-scope and unknown-version browser data is ignored", () => {
	const storage = new MemoryStorage();
	const key = "hipi.work.local.v1.store.pending.w.c";
	for (const raw of [
		"not-json",
		JSON.stringify({ version: 2 }),
		JSON.stringify({ version: 1, storeId: "other", kind: "pending", key: "w.c", input, confirmed: false }),
		JSON.stringify({
			version: 1,
			storeId: "store",
			kind: "pending",
			key: "w.c",
			input: { ...input, conversationId: "other" },
			confirmed: false,
		}),
	]) {
		storage.setItem(key, raw);
		assert.equal(new LocalState("store", storage).pending("w.c"), null);
	}
});

test("failed persistence prevents submission admission while retaining an editable in-memory draft", () => {
	const storage = new MemoryStorage();
	storage.setItem = () => {
		throw new Error("quota");
	};
	const local = new LocalState("store", storage);
	assert.equal(local.write("draft.w.c", "draft"), false);
	assert.equal(local.read("draft.w.c"), "draft");
	assert.throws(() => local.remember("w.c", input));
	assert.equal(local.pending("w.c"), null);
	assert.equal(local.storageAvailable, false);
});

test("old connection callbacks cannot overwrite restored input or persist a new request", () => {
	const storage = new MemoryStorage();
	const old = new LocalState("store", storage);
	old.write("draft.w.c", "before");
	old.deactivate();
	const current = new LocalState("store", storage);
	current.write("draft.w.c", "current");
	assert.equal(old.write("draft.w.c", "stale callback"), false);
	assert.throws(() => old.remember("w.c", input));
	assert.equal(new LocalState("store", storage).read("draft.w.c"), "current");
});

test("independent tabs preserve other scopes and cannot replace an unresolved request", () => {
	const storage = new MemoryStorage();
	const first = new LocalState("store", storage);
	const second = new LocalState("store", storage);
	first.remember("w.c", input);
	second.write("draft.w.other", "separate");
	assert.throws(() => second.remember("w.c", { ...input, requestId: "different" }));
	assert.deepEqual(new LocalState("store", storage).pending("w.c"), input);
	assert.equal(new LocalState("store", storage).read("draft.w.other"), "separate");
});

test("simultaneous browser admissions serialize before saving and allow only one unresolved request", async (t) => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	let queue = Promise.resolve();
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			locks: {
				request: (_name: string, callback: () => void) => {
					const next = queue.then(callback);
					queue = next.catch(() => {});
					return next;
				},
			},
		},
	});
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	});
	const storage = new MemoryStorage();
	const first = new LocalState("store", storage);
	const second = new LocalState("store", storage);
	const results = await Promise.allSettled([
		first.rememberForSubmission("w.c", input),
		second.rememberForSubmission("w.c", { ...input, requestId: "different" }),
	]);
	assert.equal(results[0]?.status, "fulfilled");
	assert.equal(results[1]?.status, "rejected");
	assert.deepEqual(new LocalState("store", storage).pending("w.c"), input);
});

test("receipt confirmation cannot clear a different tab's newer draft", () => {
	const storage = new MemoryStorage();
	const first = new LocalState("store", storage);
	first.write("draft.w.c", input.text);
	const second = new LocalState("store", storage);
	second.write("draft.w.c", "newer tab input");
	assert.equal(first.clearDraft("draft.w.c", input.text), false);
	assert.equal(new LocalState("store", storage).read("draft.w.c"), "newer tab input");
});

test("released writer lease blocks callbacks synchronously before provider cleanup", () => {
	const storage = new MemoryStorage();
	let active = true;
	const old = new LocalState("store", storage, () => active);
	old.remember("w.c", input);
	old.write("draft.w.c", input.text);
	active = false;
	assert.equal(old.write("draft.w.c", "late edit"), false);
	assert.equal(old.clearDraft("draft.w.c", input.text), false);
	old.confirmed("r");
	assert.throws(() => old.remember("w.c", { ...input, requestId: "late" }));
	const restored = new LocalState("store", storage);
	assert.equal(restored.isConfirmed("r"), false);
	assert.equal(restored.read("draft.w.c"), input.text);
	assert.deepEqual(restored.pending("w.c"), input);
});

test("failed draft clearing cannot persist a confirmation that would resurrect a sendable submitted draft", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("draft.w.c", input.text);
	local.remember("w.c", input);
	const save = storage.setItem.bind(storage);
	storage.setItem = (key, value) => {
		if (key.endsWith("value.draft.w.c")) throw new Error("draft write failed");
		save(key, value);
	};
	assert.equal(local.clearDraft("draft.w.c", input.text), false);
	local.confirmed(input.requestId);
	const restored = new LocalState("store", storage);
	assert.equal(restored.isConfirmed(input.requestId), false);
	assert.deepEqual(restored.pending("w.c"), input);
	assert.equal(restored.read("draft.w.c"), input.text);
	storage.setItem = save;
	assert.equal(restored.clearDraft("draft.w.c", input.text), true);
	restored.confirmed(input.requestId);
	const recovered = new LocalState("store", storage);
	assert.equal(recovered.read("draft.w.c"), "");
	assert.equal(recovered.isConfirmed(input.requestId), true);
});

test("storage schema v1 pending records remain readable under the current wire protocol", () => {
	const storage = new MemoryStorage();
	const key = "hipi.work.local.v1.store.pending.w.c";
	const saved = JSON.stringify({ version: 1, storeId: "store", kind: "pending", key: "w.c", input, confirmed: false });
	storage.setItem(key, saved);
	storage.setItem(
		"hipi.work.local.v1.store.value.draft.w.c",
		JSON.stringify({ version: 1, storeId: "store", kind: "value", key: "draft.w.c", value: "later draft" }),
	);
	const restored = new LocalState("store", storage);
	assert.deepEqual(restored.pending("w.c"), input);
	assert.equal(restored.read("draft.w.c"), "later draft");
	assert.equal(storage.getItem(key), saved);
	assert.equal(new LocalState("other-store", storage).pending("w.c"), null);
});
