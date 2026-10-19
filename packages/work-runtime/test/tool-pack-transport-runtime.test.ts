import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AppClient } from "../src/contracts.ts";
import { type ToolPackCommandLookup, toolPackCommandPayload } from "../src/extensions/contracts.ts";
import { openRuntime } from "../src/node.ts";
import { serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { createNodeIpcClient } from "../src/transport-ipc.ts";

// Formatting, CRLF, non-ASCII text and trailing whitespace are part of the installed identity.
const packageText = `${JSON.stringify(
	{
		formatVersion: 1,
		id: "example.transport",
		version: "1.0.0",
		name: "Transport",
		description: "Exact 原文",
		tools: [{ id: "trim", name: "Trim", description: "Trim ends", pipeline: [{ op: "trimLineEnds" }] }],
	},
	null,
	2,
).replaceAll("\n", "\r\n")}\r\n `;
const digest = createHash("sha256").update(packageText).digest("hex");
const model = { provider: "faux", modelId: "faux-1" };

async function lifecycle(client: AppClient) {
	await client.call("createWorkspace", { workspaceId: "work", name: "Transport" });
	const conversation = await client.call("createConversation", {
		workspaceId: "work",
		requestId: "create",
		title: "Tool packs",
	});
	const scope = { workspaceId: "work", conversationId: conversation.conversationId };
	const other = await client.call("createConversation", {
		workspaceId: "work",
		requestId: "create-other",
		title: "Other scope",
	});
	const preview = await client.call("previewToolPack", { workspaceId: "work", packageText });
	assert.deepEqual(preview, {
		digest,
		packageId: "example.transport",
		version: "1.0.0",
		name: "Transport",
		description: "Exact 原文",
		toolCount: 1,
		tools: [{ id: "trim", name: "Trim", description: "Trim ends", stepCount: 1 }],
	});
	assert.deepEqual(await client.call("listToolPacks", { workspaceId: "work" }), { items: [], nextCursor: null });
	const install = {
		workspaceId: "work",
		requestId: "install",
		packageText,
		expectedDigest: digest,
		disclosureVersion: 1 as const,
	};
	const installed = await client.call("installToolPack", install);
	assert.equal(installed.status, "disabled");
	assert.equal(installed.revision, 1);
	assert.equal(installed.digest, digest);
	assert.deepEqual(await client.call("installToolPack", install), installed);
	const source = await client.call("getToolPackSource", { workspaceId: "work", digest });
	assert.deepEqual(source, { workspaceId: "work", digest, packageText });
	assert.deepEqual(Buffer.from(source.packageText), Buffer.from(packageText));
	const enable = {
		workspaceId: "work",
		requestId: "enable",
		digest,
		expectedRevision: installed.revision,
		enabled: true,
	};
	const enabled = await client.call("setToolPackEnabled", enable);
	assert.equal(enabled.status, "enabled");
	assert.equal(enabled.revision, 2);
	assert.deepEqual(await client.call("listActiveToolPackBindings", scope), []);
	const bind = {
		...scope,
		requestId: "bind",
		digest,
		expectedPackRevision: enabled.revision,
		model,
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1 as const,
	};
	await assert.rejects(
		client.call("bindToolPack", { ...bind, requestId: "wrong-model", model: { ...model, modelId: "another" } }),
		{ code: "UNAUTHORIZED" },
	);
	const binding = await client.call("bindToolPack", bind);
	assert.deepEqual(binding.model, model);
	assert.equal(binding.purpose, "live-package");
	assert.equal(binding.disclosed, false);
	assert.equal(binding.status, "active");
	assert.deepEqual(await client.call("listActiveToolPackBindings", scope), [binding]);
	assert.deepEqual(await client.call("listToolPackBindings", scope), { items: [binding], nextCursor: null });
	assert.deepEqual(await client.call("listToolPackBindings", { ...scope, conversationId: other.conversationId }), {
		items: [],
		nextCursor: null,
	});
	const revoke = { ...scope, requestId: "revoke", bindingId: binding.bindingId, expectedRevision: binding.revision };
	const revoked = await client.call("revokeToolPackBinding", revoke);
	assert.equal(revoked.status, "revoked");
	assert.equal(revoked.revision, 2);
	const disable = { ...enable, requestId: "disable", expectedRevision: enabled.revision, enabled: false };
	const disabled = await client.call("setToolPackEnabled", disable);
	assert.equal(disabled.status, "disabled");
	const uninstall = { workspaceId: "work", requestId: "uninstall", digest, expectedRevision: disabled.revision };
	const uninstalled = await client.call("uninstallToolPack", uninstall);
	assert.equal(uninstalled.status, "uninstalled");
	assert.equal(uninstalled.revision, 4);
	// Lookups retain the ORIGINAL method, digest and scope while returning CURRENT state.
	const lookups: ToolPackCommandLookup[] = [
		{
			workspaceId: "work",
			method: "installToolPack",
			requestId: install.requestId,
			requestDigest: createHash("sha256").update(toolPackCommandPayload("installToolPack", install)).digest("hex"),
		},
		{
			workspaceId: "work",
			method: "setToolPackEnabled",
			requestId: enable.requestId,
			requestDigest: createHash("sha256").update(toolPackCommandPayload("setToolPackEnabled", enable)).digest("hex"),
		},
		{
			workspaceId: "work",
			method: "setToolPackEnabled",
			requestId: disable.requestId,
			requestDigest: createHash("sha256")
				.update(toolPackCommandPayload("setToolPackEnabled", disable))
				.digest("hex"),
		},
		{
			workspaceId: "work",
			method: "uninstallToolPack",
			requestId: uninstall.requestId,
			requestDigest: createHash("sha256")
				.update(toolPackCommandPayload("uninstallToolPack", uninstall))
				.digest("hex"),
		},
		{
			...scope,
			method: "bindToolPack",
			requestId: bind.requestId,
			requestDigest: createHash("sha256").update(toolPackCommandPayload("bindToolPack", bind)).digest("hex"),
		},
		{
			...scope,
			method: "revokeToolPackBinding",
			requestId: revoke.requestId,
			requestDigest: createHash("sha256")
				.update(toolPackCommandPayload("revokeToolPackBinding", revoke))
				.digest("hex"),
		},
	];
	const readCurrent = async (reader: AppClient) => {
		assert.deepEqual(await reader.call("listToolPacks", { workspaceId: "work" }), {
			items: [uninstalled],
			nextCursor: null,
		});
		assert.deepEqual(await reader.call("getToolPackSource", { workspaceId: "work", digest }), source);
		assert.deepEqual(await reader.call("listActiveToolPackBindings", scope), []);
		assert.deepEqual(await reader.call("listToolPackBindings", scope), { items: [revoked], nextCursor: null });
		for (const lookup of lookups) {
			assert.deepEqual(await reader.call("getToolPackCommandResult", lookup), {
				method: lookup.method,
				requestDigest: lookup.requestDigest,
				scope: "conversationId" in lookup ? scope : { workspaceId: "work" },
				result: "conversationId" in lookup ? revoked : uninstalled,
			});
		}
	};
	await readCurrent(client);
	const lookup = lookups[0];
	assert.equal(await client.call("getToolPackCommandResult", { ...lookup, requestId: "missing" }), null);
	await assert.rejects(client.call("getToolPackCommandResult", { ...lookup, requestDigest: "0".repeat(64) }), {
		code: "IDEMPOTENCY_CONFLICT",
	});
	await assert.rejects(
		client.call("getToolPackCommandResult", {
			workspaceId: "work",
			requestId: "install",
			method: "uninstallToolPack",
			requestDigest: lookup.requestDigest,
		}),
		{ code: "IDEMPOTENCY_CONFLICT" },
	);
	const bindingLookup = lookups[4];
	assert.ok("conversationId" in bindingLookup);
	await assert.rejects(
		client.call("getToolPackCommandResult", { ...bindingLookup, conversationId: other.conversationId }),
		{ code: "IDEMPOTENCY_CONFLICT" },
	);
	await assert.rejects(client.call("setToolPackEnabled", { ...enable, requestId: "stale" }), {
		code: "IDEMPOTENCY_CONFLICT",
	});
	await assert.rejects(client.call("installToolPack", { ...install, packageText: `${packageText}\n` }), {
		code: "IDEMPOTENCY_CONFLICT",
	});
	return readCurrent;
}

test(
	"tool packs roundtrip through HTTP and cold SQLite reads preserve source and command envelopes",
	{ timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-pack-http-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let runtime = await openRuntime(directory, { models, model, resume: true });
		const origin = "http://127.0.0.1:4000";
		let server: Awaited<ReturnType<typeof serveLoopback>> | undefined;
		try {
			server = await serveLoopback(runtime, { origin });
			const readCurrent = await lifecycle(createHttpClient({ ...server, origin }));
			assert.equal(faux.state.callCount, 0);
			await server.close();
			server = undefined;
			await runtime.close();
			const path = join(directory, "work", "workspace.sqlite");
			const before = await readFile(path);
			runtime = await openRuntime(directory, { models, model, resume: true });
			server = await serveLoopback(runtime, { origin });
			await readCurrent(createHttpClient({ ...server, origin }));
			await server.close();
			server = undefined;
			await runtime.close();
			assert.equal(faux.state.callCount, 0);
			assert.deepEqual(await readFile(path), before, "cold feature reads must not mutate workspace storage");
		} finally {
			await server?.close();
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("tool packs roundtrip through real Node IPC with the same AppClient lifecycle", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-pack-ipc-"));
	const child = fork(new URL("./transport-runtime-child.ts", import.meta.url), [directory], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	let client: ReturnType<typeof createNodeIpcClient> | undefined;
	try {
		const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
		assert.equal(ready, "ready");
		client = createNodeIpcClient(child);
		await lifecycle(client);
	} finally {
		client?.close();
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
