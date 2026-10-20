import assert from "node:assert/strict";
import { PROTOCOL_VERSION, parseRequest } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { type CatalogCommand, readCommand, saveCommand } from "../../src/features/workbench/command-recovery.ts";
import type { BrowserStorage } from "../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../src/features/workbench/local-state.ts";
import { parseStoredRequest } from "../../src/features/workbench/recovery/stored-request.ts";

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
const request: CatalogCommand = {
	version: PROTOCOL_VERSION,
	method: "createConversation",
	params: {
		workspaceId: "workspace",
		requestId: "request",
		title: "Preserved",
		model: { provider: "fake", modelId: "test" },
	},
};
test("version 2 command recovery survives reload alongside untouched v1 drafts and submissions", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("draft.workspace.conversation", "later user edit");
	local.remember("workspace.conversation", {
		workspaceId: "workspace",
		conversationId: "conversation",
		requestId: "submit",
		text: "submitted",
	});
	saveCommand(local, "catalog", request);
	const restored = new LocalState("store", storage);
	assert.deepEqual(readCommand(restored, "catalog").request, request);
	assert.equal(restored.read("draft.workspace.conversation"), "later user edit");
	assert.equal(restored.pending("workspace.conversation")?.requestId, "submit");
	assert.equal(readCommand(new LocalState("other", storage), "catalog").request, null);
	saveCommand(restored, "catalog", null);
	assert.equal(restored.read("draft.workspace.conversation"), "later user edit");
});
test("old create records lacking request IDs and unknown versions remain preserved and blocked", () => {
	for (const saved of [
		{ version: 1, request: { method: "createConversation", params: { workspaceId: "workspace", title: "old" } } },
		{
			version: 2,
			request: { method: "createConversation", params: { workspaceId: "workspace", title: "missing ID" } },
		},
		{ version: 99, request },
	]) {
		const storage = new MemoryStorage();
		const local = new LocalState("store", storage);
		const raw = JSON.stringify(saved);
		local.write("command.catalog", raw);
		const restored = new LocalState("store", storage);
		assert.deepEqual(readCommand(restored, "catalog"), { request: null, incompatible: true });
		assert.equal(restored.read("command.catalog"), raw);
		assert.equal(restored.hasUnsavedWork(), true);
	}
});
test("failed storage and deactivated store block command admission without clearing drafts", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	local.write("draft.workspace.conversation", "keep");
	storage.setItem = () => {
		throw new Error("quota");
	};
	assert.throws(() => saveCommand(local, "catalog", request));
	assert.equal(local.read("draft.workspace.conversation"), "keep");
	local.deactivate();
	assert.throws(() => saveCommand(local, "catalog", null));
});

test("permission commands restore only in their exact store and conversation, preserving source role and original model", () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	const command = {
		version: PROTOCOL_VERSION,
		method: "authorizeRetainedContext" as const,
		params: {
			workspaceId: "workspace",
			conversationId: "conversation",
			requestId: "original",
			sourceGrantId: "old-live-grant",
			model: { provider: "fake", modelId: "original" },
			expiresAt: 5000,
			disclosureVersion: 1 as const,
		},
	};
	saveCommand(local, "permissions.workspace.conversation", command);
	const restored = new LocalState("store", storage);
	assert.deepEqual(readCommand(restored, "permissions.workspace.conversation").request, command);
	assert.equal(readCommand(restored, "permissions.workspace.other").request, null);
	assert.equal(readCommand(new LocalState("other-store", storage), "permissions.workspace.conversation").request, null);
});

test("unknown saved wire versions are not silently upgraded into replayable commands", () => {
	const local = new LocalState();
	const raw = JSON.stringify({ version: 2, request: { ...request, version: PROTOCOL_VERSION + 1 } });
	local.write("command.catalog", raw);
	assert.equal(readCommand(local, "catalog").incompatible, true);
	assert.equal(local.read("command.catalog"), raw);
});

test("only verified protocol 8 local commands normalize; the same envelopes remain invalid on the wire", () => {
	const legacy = { ...request, version: 8 };
	assert.throws(() => parseRequest(legacy), { code: "INVALID_REQUEST" });
	assert.deepEqual(parseStoredRequest(legacy), request);
	assert.equal(legacy.version, 8);
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	const raw = JSON.stringify({ version: 2, request: legacy });
	local.write("command.catalog", raw);
	const restored = new LocalState("store", storage);
	assert.deepEqual(readCommand(restored, "catalog").request, request);
	assert.equal(restored.read("command.catalog"), raw);
	assert.equal(readCommand(new LocalState("other", storage), "catalog").request, null);
	for (const invalid of [
		{ ...legacy, version: 7 },
		{ ...legacy, version: 10 },
		{ ...legacy, expectedStoreId: "store" },
		{ ...legacy, extra: true },
		{ ...legacy, params: { ...legacy.params, extra: true } },
		{ ...legacy, params: { ...legacy.params, requestId: undefined } },
		{
			version: 8,
			method: "submit",
			params: { workspaceId: "workspace", conversationId: "conversation", requestId: "submit", text: "never replay" },
		},
		{ version: 8, method: "handshake", params: {} },
		{ version: 8, method: "refreshSidebarProjection", params: {} },
	]) {
		const saved = JSON.stringify({ version: 2, request: invalid });
		local.write("command.catalog", saved);
		assert.equal(readCommand(local, "catalog").incompatible, true);
		assert.equal(local.read("command.catalog"), saved);
		assert.throws(() => parseStoredRequest(invalid));
	}
	const unknownWrapper = JSON.stringify({ version: 2, request: null, futureIntent: true });
	local.write("command.catalog", unknownWrapper);
	assert.equal(readCommand(local, "catalog").incompatible, true);
	assert.equal(local.read("command.catalog"), unknownWrapper);
});
