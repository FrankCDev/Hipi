import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseResult,
	type ToolPackRecord,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { toolPackLabels } from "../src/features/tool-packs/labels.ts";
import { type PackCommand, pendingCommand, sha256, validatePackageText } from "../src/features/tool-packs/recovery.ts";
import { bindingCapacity, ToolPackSession } from "../src/features/tool-packs/session.ts";
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
const workspaceId = "workspace";
const digest = "a".repeat(64);
const pack: ToolPackRecord = {
	workspaceId,
	digest,
	packageId: "example.tools",
	version: "1.0.0",
	name: "Example",
	description: "Example pack",
	toolCount: 1,
	formatVersion: 1,
	status: "disabled",
	revision: 1,
	installedAt: 1,
};
const command: PackCommand = {
	version: PROTOCOL_VERSION,
	method: "setToolPackEnabled",
	params: { workspaceId, requestId: "original", digest, expectedRevision: 1, enabled: true },
};
function fixture(local = new LocalState()) {
	const calls: { method: Method; params: unknown }[] = [];
	let handler: (method: Method, params: unknown) => Promise<unknown> = async () => undefined;
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>) => {
			calls.push({ method, params });
			let result = await handler(method, params);
			if (result === undefined) {
				if (method === "listToolPacks") result = { items: [pack], nextCursor: null };
				else if (method === "listActiveToolPackBindings") result = [];
				else if (method === "listToolPackBindings") result = { items: [], nextCursor: null };
				else if (method === "getToolPackCommandResult") result = null;
				else throw new Error("LOST_REPLY");
			}
			return parseResult(method, result);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	return {
		calls,
		local,
		client,
		session: new ToolPackSession(client, local, workspaceId, "conversation"),
		handle(next: typeof handler) {
			handler = next;
		},
	};
}
test("unknown mutation persists and refresh only looks up the exact method, digest and scope", async () => {
	const f = fixture();
	await f.session.refresh();
	await f.session.execute(command);
	assert.equal(f.session.getSnapshot().notFound, true);
	assert.equal(f.local.hasUnsavedWork(), true);
	await f.session.refresh();
	await f.session.refresh();
	assert.equal(f.calls.filter((call) => call.method === "setToolPackEnabled").length, 1);
	const expected = (await pendingCommand(command)).lookup;
	assert.deepEqual(
		f.calls.filter((call) => call.method === "getToolPackCommandResult").map((call) => call.params),
		[expected, expected, expected],
	);
	f.handle(async (method) =>
		method === "getToolPackCommandResult"
			? {
					method: command.method,
					requestDigest: expected.requestDigest,
					scope: { workspaceId },
					result: { ...pack, status: "enabled", revision: 2 },
				}
			: undefined,
	);
	await f.session.refresh();
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.local.hasUnsavedWork(), false);
});
test("manual retry preserves payload and checks late results before sending", async () => {
	const f = fixture();
	await f.session.refresh();
	await f.session.execute(command);
	await f.session.retry();
	assert.deepEqual(
		f.calls.filter((call) => call.method === "setToolPackEnabled").map((call) => call.params),
		[command.params, command.params],
	);
	const pending = f.session.getSnapshot().pending;
	assert.ok(pending);
	f.handle(async (method) =>
		method === "getToolPackCommandResult"
			? {
					method: command.method,
					requestDigest: pending.lookup.requestDigest,
					scope: { workspaceId },
					result: { ...pack, status: "enabled", revision: 2 },
				}
			: undefined,
	);
	await f.session.retry();
	assert.equal(f.calls.filter((call) => call.method === "setToolPackEnabled").length, 2);
});
test("installation saves metadata only and requires exact original bytes on recovery retry", async () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	const f = fixture(local);
	const packageText = '{ "privatePrompt": "never store this original text" }';
	const install: PackCommand = {
		version: PROTOCOL_VERSION,
		method: "installToolPack",
		params: {
			workspaceId,
			requestId: "install_original",
			packageText,
			expectedDigest: await sha256(packageText),
			disclosureVersion: 1,
		},
	};
	await f.session.refresh();
	await f.session.execute(install);
	assert.equal([...storage.values.values()].join().includes("privatePrompt"), false);
	const recovered = new ToolPackSession(f.client, new LocalState("store", storage), workspaceId, "conversation");
	await recovered.refresh();
	assert.equal(recovered.getSnapshot().pending?.lookup.requestId, "install_original");
	await recovered.retry('{"privatePrompt":"never store this original text"}');
	assert.equal(f.calls.filter((call) => call.method === "installToolPack").length, 1);
	await recovered.retry(packageText);
	assert.deepEqual(
		f.calls.filter((call) => call.method === "installToolPack").map((call) => call.params),
		[install.params, install.params],
	);
	assert.equal(
		new ToolPackSession(f.client, new LocalState("other_store", storage), workspaceId, "conversation").getSnapshot()
			.pending,
		null,
	);
});
test("archiving blocks new bindings and mutation retries but allows result lookup", async () => {
	const f = fixture();
	await f.session.refresh();
	await f.session.execute(command);
	f.session.setArchived(true);
	await f.session.retry();
	await f.session.refresh();
	assert.equal(f.calls.filter((call) => call.method === "setToolPackEnabled").length, 1);
	assert.ok(f.calls.filter((call) => call.method === "getToolPackCommandResult").length >= 2);
	const fresh = fixture();
	await fresh.session.refresh();
	fresh.session.setArchived(true);
	await fresh.session.execute({
		version: PROTOCOL_VERSION,
		method: "bindToolPack",
		params: {
			workspaceId,
			conversationId: "conversation",
			requestId: "bind",
			digest,
			expectedPackRevision: 1,
			disclosureVersion: 1,
			model: { provider: "fake", modelId: "model" },
			expiresAt: Date.now() + 60000,
		},
	});
	assert.equal(
		fresh.calls.some((call) => call.method === "bindToolPack"),
		false,
	);
});
test("storage failure prevents sending and mismatched receipts never clear recovery", async () => {
	const storage = new MemoryStorage();
	const local = new LocalState("store", storage);
	storage.setItem = () => {
		throw new Error("denied");
	};
	const blocked = fixture(local);
	await blocked.session.refresh();
	await blocked.session.execute(command);
	assert.equal(
		blocked.calls.some((call) => call.method === "setToolPackEnabled"),
		false,
	);
	const f = fixture();
	await f.session.refresh();
	await f.session.execute(command);
	f.handle(async (method) =>
		method === "getToolPackCommandResult"
			? { method: command.method, requestDigest: "f".repeat(64), scope: { workspaceId }, result: pack }
			: undefined,
	);
	await f.session.refresh();
	assert.ok(f.session.getSnapshot().pending);
	assert.equal(f.session.getSnapshot().failed, true);
});
test("disposing ignores late replies without clearing recovery", async () => {
	const f = fixture();
	await f.session.refresh();
	let release: ((value: unknown) => void) | undefined;
	f.handle(async (method) =>
		method === "setToolPackEnabled"
			? new Promise((resolve) => {
					release = resolve;
				})
			: undefined,
	);
	const sending = f.session.execute(command);
	while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
	f.session.dispose();
	await sending;
	const record = f.local.read("command.tool-packs.conversation.workspace.conversation");
	release({ ...pack, status: "enabled", revision: 2 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(f.local.read("command.tool-packs.conversation.workspace.conversation"), record);
	assert.equal(
		f.calls.some((call) => call.method === "getToolPackCommandResult"),
		false,
	);
});
test("scope isolation rejects foreign commands and foreign lists", async () => {
	const f = fixture();
	await f.session.refresh();
	await f.session.execute({ ...command, params: { ...command.params, workspaceId: "foreign" } });
	assert.equal(
		f.calls.some((call) => call.method === "setToolPackEnabled"),
		false,
	);
	f.handle(async (method) =>
		method === "listToolPacks" ? { items: [{ ...pack, workspaceId: "foreign" }], nextCursor: null } : undefined,
	);
	await f.session.refresh();
	assert.equal(f.session.getSnapshot().failed, true);
	assert.equal(f.session.getSnapshot().packs[0]?.workspaceId, workspaceId);
});
test("source validates UTF-8 size, Unicode and raw-byte hash; locale keys match", async () => {
	assert.doesNotThrow(() => validatePackageText("😀"));
	assert.doesNotThrow(() => validatePackageText("a".repeat(65536)));
	for (const text of ["", "\ud800", "\udfff", "\ufeff{}", "界".repeat(22000)])
		assert.throws(() => validatePackageText(text));
	assert.notEqual(await sha256('{ "a": 1 }'), await sha256('{"a":1}'));
	assert.deepEqual(Object.keys(toolPackLabels("en")), Object.keys(toolPackLabels("zh-CN")));
	assert.ok(Object.keys(toolPackLabels("en")).every((key) => key.startsWith("toolPacks.")));
});
test("active capacity includes retained contexts", () => {
	const live = {
		workspaceId,
		conversationId: "conversation",
		bindingId: "binding",
		digest,
		model: { provider: "fake", modelId: "model" },
		expiresAt: 1000,
		status: "active" as const,
		revision: 1,
		createdAt: 1,
		disclosureVersion: 1 as const,
		disclosed: true,
		purpose: "live-package" as const,
	};
	assert.deepEqual(
		bindingCapacity(
			Array.from({ length: 4 }, () => live),
			1,
		),
		{ live: false, retained: true },
	);
	assert.deepEqual(
		bindingCapacity(
			Array.from({ length: 32 }, () => ({ ...live, purpose: "retained-package", sourceBindingId: "old" })),
			1,
		),
		{ live: false, retained: false },
	);
	assert.deepEqual(bindingCapacity([live], 1001), { live: true, retained: true });
});
test("workspace and a conversation literally named workspace have separate recovery keys", async () => {
	const f = fixture();
	const workspaceSession = new ToolPackSession(f.client, f.local, workspaceId);
	await workspaceSession.refresh();
	await workspaceSession.execute(command);
	const conversationSession = new ToolPackSession(f.client, f.local, workspaceId, "workspace");
	assert.equal(conversationSession.getSnapshot().pending, null);
	assert.ok(new ToolPackSession(f.client, f.local, workspaceId).getSnapshot().pending);
});
test("corrupt recovery is preserved and never automatically resent", async () => {
	const f = fixture();
	const key = "command.tool-packs.conversation.workspace.conversation";
	f.local.write(key, '{"version":100,"pending":{"method":"installToolPack"}}');
	const restored = new ToolPackSession(f.client, f.local, workspaceId, "conversation");
	const raw = f.local.read(key);
	await restored.refresh();
	await restored.execute(command);
	await restored.retry();
	assert.equal(restored.getSnapshot().incompatible, true);
	assert.equal(f.local.read(key), raw);
	assert.equal(
		f.calls.some((call) => call.method === "setToolPackEnabled"),
		false,
	);
});
test("source reads never expose a mismatched hash or foreign scope", async () => {
	const f = fixture();
	f.handle(async (method) =>
		method === "getToolPackSource" ? { workspaceId, digest, packageText: '{"arbitrary":"source"}' } : undefined,
	);
	await f.session.source(digest);
	assert.equal(f.session.getSnapshot().source, null);
	assert.equal(f.session.getSnapshot().failed, true);
});
