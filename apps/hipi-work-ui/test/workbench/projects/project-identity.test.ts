import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { admitInitialSend } from "../../../src/features/workbench/catalog/initial-send.ts";
import { type BrowserStorage, LocalPersistence } from "../../../src/features/workbench/local-persistence.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { admitProjectCommand } from "../../../src/features/workbench/projects/commands.ts";
import {
	canCreateProjectless,
	defaultRoleEvidence,
	legacyAdoptionInput,
} from "../../../src/features/workbench/projects/identity.ts";

const ready = { state: "ready", generation: 1, defaultWorkspaceId: null } as const;

class QueuedLocalState extends LocalState {
	gate: Promise<void> = Promise.resolve();
	override async withAdmission<T>(_key: string, work: () => T): Promise<T> {
		await this.gate;
		return work();
	}
}

function memoryStorage(): BrowserStorage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		key: (index) => [...values.keys()][index] ?? null,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
}

test("project-only catalog without default evidence permits explicit projectless Send", () => {
	const local = new LocalState();
	assert.equal(canCreateProjectless(local, ready), true);
	assert.deepEqual(defaultRoleEvidence(local), { kind: "absent" });
	assert.equal(legacyAdoptionInput(local, ready), null);
});

test("legacy command marker is preserved and cannot silently authorize adoption or a duplicate default", () => {
	const local = new LocalState();
	const legacy = JSON.stringify({
		version: 8,
		method: "createWorkspace",
		params: { workspaceId: "old", name: "Chats" },
	});
	local.write("default-chat-workspace", legacy);
	assert.deepEqual(defaultRoleEvidence(local), { kind: "unresolved" });
	assert.equal(legacyAdoptionInput(local, ready), null);
	assert.equal(canCreateProjectless(local, ready), false);
	assert.equal(local.read("default-chat-workspace"), legacy);
});

test("malformed or conflicting marker never selects a default by name", () => {
	const local = new LocalState();
	for (const marker of [
		"broken",
		JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "old", extra: true }),
		JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "old" }),
	]) {
		local.write("default-chat-workspace", marker);
		assert.equal(canCreateProjectless(local, { ...ready, defaultWorkspaceId: "different" }), false);
	}
});

test("adoption reads authoritative store-bound marker rather than a stale loaded marker", () => {
	const values = new Map<string, string>();
	const storage: BrowserStorage = {
		get length() {
			return values.size;
		},
		key: (index) => [...values.keys()][index] ?? null,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
	const persistence = new LocalPersistence("store", storage);
	persistence.save({
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "old" }),
	});
	const local = new LocalState("store", storage);
	persistence.save({
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "new" }),
	});
	const input = legacyAdoptionInput(local, ready);
	assert.equal(input?.workspaceId, "new");
	assert.equal(input?.provenance.storeId, "store");
	assert.equal(input?.expectedCatalogGeneration, ready.generation);
	assert.match(local.read("default-chat-workspace") ?? "", /old/);
});

test("a changed durable marker while adoption waits for admission cannot authorize the captured workspace", async () => {
	const storage = memoryStorage();
	const local = new QueuedLocalState("store", storage);
	local.write(
		"default-chat-workspace",
		JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "old" }),
	);
	const input = legacyAdoptionInput(local, ready);
	assert.ok(input);
	let release: (() => void) | undefined;
	local.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = admitProjectCommand(
		local,
		{ version: PROTOCOL_VERSION, method: "adoptLegacyDefaultWorkspace", params: input },
		new AbortController().signal,
	);
	new LocalPersistence("store", storage).save({
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: "new" }),
	});
	assert.ok(release);
	release();
	await assert.rejects(pending, /DEFAULT_WORKSPACE_CHANGED/);
	assert.equal(local.read("command.catalog"), null);
});

test("a newly unresolved marker while projectless Send waits prevents journal admission", async () => {
	const local = new QueuedLocalState();
	local.write("new-chat-draft.source", "Keep my text");
	local.write(
		"new-chat.active",
		JSON.stringify({ version: 1, generation: "generation", sourceKey: "new-chat-draft.source" }),
	);
	let release: (() => void) | undefined;
	local.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = admitInitialSend(
		local,
		{
			projectId: null,
			workspaceId: null,
			title: "Title",
			text: "Keep my text",
			sourceKey: "new-chat-draft.source",
			sourceGeneration: "generation",
		},
		new AbortController().signal,
		ready,
	);
	local.write("default-chat-workspace", "unresolved");
	assert.ok(release);
	release();
	await assert.rejects(pending, /PROJECT_DESTINATION_UNVERIFIED/);
	assert.equal(local.read("command.catalog"), null);
	assert.equal(local.read("new-chat-draft.source"), "Keep my text");
});
