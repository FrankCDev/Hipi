import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	type ToolPackBinding,
	type ToolPackRecord,
	toolPackCommandPayload,
} from "../src/contracts.ts";
import { WorkRuntime } from "../src/core.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";
import { deniedFeatureReads } from "./feature-port-fixture.ts";
import { fixtureRuntime } from "./transport-fixture.ts";

const scope = { workspaceId: "test", conversationId: "conversation" };
const digest = "a".repeat(64);
const pack: ToolPackRecord = {
	workspaceId: "test",
	digest,
	packageId: "example.text",
	version: "1.0.0",
	name: "Text",
	description: "Text utilities",
	toolCount: 1,
	status: "disabled",
	revision: 1,
	installedAt: 1,
	formatVersion: 1,
};
const binding: ToolPackBinding = {
	...scope,
	bindingId: "binding",
	digest,
	model: { provider: "faux", modelId: "faux-1" },
	expiresAt: 2000000000000,
	status: "active",
	revision: 1,
	createdAt: 1,
	disclosureVersion: 1,
	disclosed: false,
	purpose: "live-package",
};
const install = {
	workspaceId: "test",
	requestId: "install",
	packageText: "{}",
	expectedDigest: digest,
	disclosureVersion: 1 as const,
};
function request(method: string, params: unknown) {
	return parseRequest({ version: PROTOCOL_VERSION, expectedStoreId: "store", method, params });
}

test("protocol 14 refuses old and future requests and server handshakes", () => {
	assert.equal(PROTOCOL_VERSION, 14);
	for (const version of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15]) {
		assert.throws(() => parseRequest({ version, method: "handshake", params: {} }), { code: "INVALID_REQUEST" });
		assert.throws(() => parseResult("handshake", { protocolVersion: version, storeId: "store" }), {
			code: "INVALID_REQUEST",
		});
	}
});
test("package commands validate exact immutable identity, disclosure, raw UTF-8 and unknown fields", () => {
	assert.deepEqual(request("installToolPack", install).params, install);
	for (const patch of [
		{ disclosureVersion: 2 },
		{ expectedDigest: "A".repeat(64) },
		{ packageText: "\ud800" },
		{ packageText: "\ufeff{}" },
		{ packageText: "😀".repeat(16385) },
		{ packageText: "x".repeat(65537) },
		{ enabled: true },
		{ conversationId: "other" },
	])
		assert.throws(() => request("installToolPack", { ...install, ...patch }), { code: "INVALID_REQUEST" });
	const input = {
		...scope,
		requestId: "bind",
		digest,
		expectedPackRevision: 1,
		model: binding.model,
		expiresAt: binding.expiresAt,
		disclosureVersion: 1,
	};
	assert.deepEqual(request("bindToolPack", input).params, input);
	for (const patch of [
		{ expectedPackRevision: 0 },
		{ model: { ...binding.model, key: "secret" } },
		{ purpose: "retained-package" },
		{ sourceBindingId: "other" },
		{ expiresAt: Infinity },
	])
		assert.throws(() => request("bindToolPack", { ...input, ...patch }), { code: "INVALID_REQUEST" });
	const retained = {
		...scope,
		requestId: "retained",
		sourceBindingId: "binding",
		model: binding.model,
		expiresAt: binding.expiresAt,
		disclosureVersion: 1,
	};
	assert.deepEqual(request("authorizeRetainedToolPack", retained).params, retained);
	assert.throws(() => request("authorizeRetainedToolPack", { ...retained, digest }), { code: "INVALID_REQUEST" });
});
test("command payload is key-order independent and lookup requires original method, scope and digest", () => {
	assert.equal(
		toolPackCommandPayload("installToolPack", install),
		toolPackCommandPayload("installToolPack", {
			disclosureVersion: 1,
			expectedDigest: digest,
			packageText: "{}",
			requestId: "install",
			workspaceId: "test",
		}),
	);
	const lookup = { workspaceId: "test", requestId: "install", method: "installToolPack", requestDigest: digest };
	assert.deepEqual(request("getToolPackCommandResult", lookup).params, lookup);
	for (const patch of [
		{ method: "previewToolPack" },
		{ requestDigest: undefined },
		{ conversationId: "conversation" },
		{ retry: true },
	])
		assert.throws(() => request("getToolPackCommandResult", { ...lookup, ...patch }), { code: "INVALID_REQUEST" });
	assert.throws(() => request("getToolPackCommandResult", { ...lookup, method: "bindToolPack" }), {
		code: "INVALID_REQUEST",
	});
	assert.deepEqual(request("getToolPackCommandResult", { ...lookup, ...scope, method: "bindToolPack" }).params, {
		...lookup,
		...scope,
		method: "bindToolPack",
	});
	const result = { method: "installToolPack", scope: { workspaceId: "test" }, requestDigest: digest, result: pack };
	assert.deepEqual(parseResult("getToolPackCommandResult", result), result);
	assert.throws(() => parseResult("getToolPackCommandResult", { ...result, scope: { workspaceId: "other" } }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("getToolPackCommandResult", { ...result, method: "bindToolPack" }), {
		code: "INVALID_REQUEST",
	});
	assert.equal(parseResult("getToolPackCommandResult", null), null);
});
test("summary pages exclude source and active bindings independently bound live and retained authority", () => {
	assert.deepEqual(parseResult("listToolPacks", { items: [pack], nextCursor: null }), {
		items: [pack],
		nextCursor: null,
	});
	assert.throws(() => parseResult("listToolPacks", { items: [{ ...pack, packageText: "{}" }], nextCursor: null }), {
		code: "INVALID_REQUEST",
	});
	assert.throws(() => parseResult("listToolPacks", { items: [pack, pack], nextCursor: null }), {
		code: "INVALID_REQUEST",
	});
	const retained: ToolPackBinding = {
		...binding,
		bindingId: "retained",
		purpose: "retained-package",
		sourceBindingId: "binding",
	};
	assert.deepEqual(parseResult("authorizeRetainedToolPack", retained), retained);
	assert.throws(() => parseResult("bindToolPack", retained), { code: "INVALID_REQUEST" });
	assert.throws(() => parseResult("authorizeRetainedToolPack", binding), { code: "INVALID_REQUEST" });
	assert.throws(() => parseResult("revokeToolPackBinding", { ...binding, sourceBindingId: "binding" }), {
		code: "INVALID_REQUEST",
	});
	const active = Array.from({ length: 32 }, (_, i) => ({
		...(i < 4 ? binding : retained),
		bindingId: `binding-${i}`,
	}));
	assert.equal(parseResult("listActiveToolPackBindings", active).length, 32);
	assert.throws(() => parseResult("listActiveToolPackBindings", [...active, { ...retained, bindingId: "overflow" }]), {
		code: "INVALID_REQUEST",
	});
	assert.throws(
		() =>
			parseResult(
				"listActiveToolPackBindings",
				active.slice(0, 5).map((item) => ({ ...binding, bindingId: item.bindingId })),
			),
		{ code: "INVALID_REQUEST" },
	);
	assert.throws(() => parseResult("listActiveToolPackBindings", [{ ...binding, status: "revoked" }]), {
		code: "INVALID_REQUEST",
	});
});
test("all feature reads bypass workspace admission and reject store mismatch before reading", async () => {
	const forbidden = async (): Promise<never> => {
		throw new Error("Must not open a Harness");
	};
	let reads = 0;
	const runtime = new WorkRuntime({
		...deniedFeatureReads,
		storeId: "store",
		getWorkspace: forbidden,
		getConversation: forbidden,
		getConversationCommandResult: forbidden,
		getAgentCommandResult: forbidden,
		listModels: forbidden,
		listWorkspaces: forbidden,
		listConversations: forbidden,
		openWorkspace: forbidden,
		close: async () => {},
		listToolPacks: async () => {
			reads++;
			return { items: [pack], nextCursor: null };
		},
		getToolPackCommandResult: async () => null,
		getToolActivities: async () => ({ items: [], nextCursor: null, coverage: "tasks", membershipFence: "fence" }),
	});
	try {
		assert.deepEqual(await runtime.call("listToolPacks", { workspaceId: "test" }), {
			items: [pack],
			nextCursor: null,
		});
		assert.equal(
			await runtime.call("getToolPackCommandResult", {
				workspaceId: "test",
				requestId: "install",
				method: "installToolPack",
				requestDigest: digest,
			}),
			null,
		);
		assert.deepEqual(await runtime.call("getToolActivities", scope), {
			items: [],
			nextCursor: null,
			coverage: "tasks",
			membershipFence: "fence",
		});
		await assert.rejects(
			runtime.execute({ ...request("listToolPacks", { workspaceId: "test" }), expectedStoreId: "other" }),
			{ code: "STORE_MISMATCH" },
		);
		assert.equal(reads, 1);
	} finally {
		await runtime.close();
	}
});
test("HTTP and IPC expose the same fail-closed pack lifecycle and activity calls", { timeout: 15000 }, async () => {
	const runtime = fixtureRuntime();
	const origin = "http://127.0.0.1:4000";
	const server = await serveLoopback(runtime, { origin });
	const child = fork(new URL("./transport-fixture.ts", import.meta.url), ["--transport-fixture"], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const ipc = createNodeIpcClient(child);
	try {
		for (const client of [createHttpClient({ ...server, origin }), ipc]) {
			await assert.rejects(client.call("previewToolPack", { workspaceId: "test", packageText: "{}" }), {
				code: "UNAUTHORIZED",
			});
			await assert.rejects(client.call("installToolPack", install), { code: "UNAUTHORIZED" });
			await assert.rejects(client.call("listToolPacks", { workspaceId: "test" }), { code: "UNAUTHORIZED" });
			await assert.rejects(client.call("getToolPackSource", { workspaceId: "test", digest }), {
				code: "UNAUTHORIZED",
			});
			await assert.rejects(
				client.call("setToolPackEnabled", {
					workspaceId: "test",
					requestId: "enable",
					digest,
					expectedRevision: 1,
					enabled: true,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(
				client.call("uninstallToolPack", {
					workspaceId: "test",
					requestId: "uninstall",
					digest,
					expectedRevision: 1,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(
				client.call("bindToolPack", {
					...scope,
					requestId: "bind",
					digest,
					expectedPackRevision: 1,
					model: binding.model,
					expiresAt: binding.expiresAt,
					disclosureVersion: 1,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(
				client.call("revokeToolPackBinding", {
					...scope,
					requestId: "revoke",
					bindingId: "binding",
					expectedRevision: 1,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(
				client.call("authorizeRetainedToolPack", {
					...scope,
					requestId: "retained",
					sourceBindingId: "binding",
					model: binding.model,
					expiresAt: binding.expiresAt,
					disclosureVersion: 1,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(client.call("listToolPackBindings", scope), { code: "UNAUTHORIZED" });
			await assert.rejects(client.call("listActiveToolPackBindings", scope), { code: "UNAUTHORIZED" });
			await assert.rejects(
				client.call("getToolPackCommandResult", {
					workspaceId: "test",
					requestId: "install",
					method: "installToolPack",
					requestDigest: digest,
				}),
				{ code: "UNAUTHORIZED" },
			);
			await assert.rejects(client.call("getToolActivities", scope), { code: "UNAUTHORIZED" });
			await assert.rejects(client.call("getToolActivityText", { ...scope, activityId: "activity" }), {
				code: "UNAUTHORIZED",
			});
		}
	} finally {
		ipc.close();
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
		await server.close();
		await runtime.close();
	}
});
