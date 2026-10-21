import assert from "node:assert/strict";
import { type AppClient, PROTOCOL_VERSION, parseRequest, parseResult } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { CatalogSession } from "../../src/features/workbench/catalog/session.ts";
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

test.each([8, 9, 10])(
	"only verified protocol %i local commands normalize; old envelopes remain invalid on the wire",
	(version) => {
		const legacy = { ...request, version };
		assert.throws(() => parseRequest(legacy), { code: "INVALID_REQUEST" });
		assert.deepEqual(parseStoredRequest(legacy), request);
		assert.equal(legacy.version, version);
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
			{ ...legacy, version: PROTOCOL_VERSION + 1 },
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
	},
);

test.each([8, 9, 10])(
	"protocol %i recovery preserves approval identities and digest bytes and rejects malformed fields",
	(version) => {
		const params = {
			workspaceId: "workspace",
			conversationId: "conversation",
			requestId: "original-request",
			approvalId: "original-approval",
			expectedRevision: 3,
			decision: "approve",
			argumentsDigest: "a".repeat(64),
			contentDigest: "b".repeat(64),
		};
		const command = { version, method: "decideToolApproval", params };
		const raw = JSON.stringify(command);
		assert.deepEqual(parseStoredRequest(command).params, params);
		assert.equal(JSON.stringify(command), raw);
		for (const patch of [
			{ requestId: "invalid/id" },
			{ workspaceId: "" },
			{ conversationId: "foreign/scope" },
			{ approvalId: "" },
			{ argumentsDigest: "a".repeat(63) },
			{ contentDigest: "G".repeat(64) },
			{ expectedRevision: 0 },
		]) {
			const local = new LocalState();
			const saved = JSON.stringify({ version: 2, request: { ...command, params: { ...params, ...patch } } });
			local.write("command.permissions", saved);
			assert.deepEqual(readCommand(local, "permissions"), { request: null, incompatible: true });
			assert.equal(local.read("command.permissions"), saved);
			assert.equal(local.hasUnsavedWork(), true);
		}
	},
);

test.each([8, 9, 10])(
	"protocol %i unknown outcome remains receipt-only after reload without rewriting or resending",
	async (version) => {
		const storage = new MemoryStorage();
		const local = new LocalState("store", storage);
		const raw = JSON.stringify({ version: 2, request: { ...request, version } }, null, 2);
		local.write("command.catalog", raw);
		const originalStorage = [...storage.values];
		const restored = new LocalState("store", storage);
		const calls: unknown[] = [];
		const client: AppClient = {
			call: async (method, params) => {
				calls.push({ method, params });
				assert.equal(method, "getConversationCommandResult");
				return parseResult(method, null);
			},
			observe: async () => {
				throw new Error("Recovery must not observe or execute a conversation");
			},
		};
		const session = new CatalogSession(client, restored);
		try {
			assert.deepEqual(calls, []);
			await session.check();
			await session.check();
			assert.deepEqual(
				calls,
				Array(2).fill({
					method: "getConversationCommandResult",
					params: { workspaceId: "workspace", requestId: "request" },
				}),
			);
			assert.equal(session.getSnapshot().notFound, true);
			assert.equal(session.getSnapshot().incompatible, false);
			assert.deepEqual(session.getSnapshot().pending, request);
			assert.equal(restored.hasUnsavedWork(), true);
			assert.equal(restored.read("command.catalog"), raw);
			assert.deepEqual([...storage.values], originalStorage);
		} finally {
			session.dispose();
		}
	},
);
