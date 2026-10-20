import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { DocumentId, JsonObject, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AppError } from "../src/contracts.ts";
import { packCommandKey } from "../src/extensions/lifecycle-store.ts";
import { parseToolPack } from "../src/extensions/pack.ts";
import { openRuntime } from "../src/node.ts";
import { openTestRuntime } from "../src/testing.ts";

async function put(storage: Storage, kind: string, value: JsonObject, key?: string, version = 1) {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
		"current",
		context,
	);
	await storage.commit(
		[
			record
				? { type: "document.change", id: record.id, content: { kind: "base", version, value } }
				: {
						type: "document.create",
						record: {
							id: await storage.mintId<DocumentId>(),
							kind,
							scope: { kind: "session" },
							...(key === undefined ? {} : { key }),
						},
						content: { kind: "base", version, value },
					},
		],
		context,
	);
}
const packageText = JSON.stringify(
	{
		formatVersion: 1,
		id: "example.clean",
		version: "1.0.0",
		name: "Clean",
		description: "Exact 原文",
		tools: [{ id: "trim", name: "Trim", description: "Trim ends", pipeline: [{ op: "trimLineEnds" }] }],
	},
	null,
	2,
);
const digest = parseToolPack(Buffer.from(packageText)).digest;
const requestDigest = "a".repeat(64);

test("cold feature reads use public Storage, retain exact source and current command result without scheduling", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-feature-reads-"));
	let runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("paused");
		},
	});
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Read",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "pending", text: "Remain paused" }), /paused/);
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			const record = {
				workspaceId: "work",
				digest,
				packageId: "example.clean",
				version: "1.0.0",
				name: "Clean",
				description: "Exact 原文",
				toolCount: 1,
				formatVersion: 1,
				status: "disabled",
				revision: 1,
				installedAt: 1,
			};
			await put(
				storage,
				"hipi.tool-pack",
				{ value: { ...record, status: "uninstalled", revision: 3 }, packageText, interpreterVersion: 1 },
				digest,
			);
			await put(storage, "hipi.tool-pack-header", { count: 1, enabled: [], live: [] });
			await put(storage, "hipi.tool-pack-audit", { ids: [digest] }, "packs-0");
			await put(
				storage,
				"hipi.tool-pack-command",
				{
					value: { method: "installToolPack", scope: { workspaceId: "work" }, requestDigest, result: record },
					resultId: digest,
				},
				packCommandKey("work", "install"),
			);
		} finally {
			await storage.close(context);
		}
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		assert.equal((await runtime.call("listToolPacks", { workspaceId: "work" })).items[0].revision, 3);
		assert.equal((await runtime.call("getToolPackSource", { workspaceId: "work", digest })).packageText, packageText);
		const lookup = { workspaceId: "work", method: "installToolPack" as const, requestId: "install", requestDigest };
		assert.equal((await runtime.call("getToolPackCommandResult", lookup))?.result.revision, 3);
		assert.equal(await runtime.call("getToolPackCommandResult", { ...lookup, requestId: "absent" }), null);
		await assert.rejects(runtime.call("getToolPackCommandResult", { ...lookup, requestDigest: "b".repeat(64) }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		assert.deepEqual(await runtime.call("listToolPackBindings", scope), { items: [], nextCursor: null });
		assert.deepEqual(await runtime.call("listActiveToolPackBindings", scope), []);
		assert.equal((await runtime.call("getToolActivities", scope)).items.length, 0);
		await assert.rejects(runtime.call("getToolActivityText", { ...scope, activityId: "t_999999" }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(faux.state.callCount, 0);
		await runtime.close();
		const reader = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			await put(reader, "hipi.tool-pack-command", {}, packCommandKey("work", "install"), 2);
		} finally {
			await reader.close(context);
		}
		runtime = await openRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
		await assert.rejects(runtime.call("getToolPackCommandResult", lookup), { code: "INDEX_RECOVERY_REQUIRED" });
		assert.equal(faux.state.callCount, 0);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("feature reads reject corrupt source, metadata scope and legacy directory without migration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-feature-corruption-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Read",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		const record = {
			workspaceId: "work",
			digest,
			packageId: "example.clean",
			version: "1.0.0",
			name: "Clean",
			description: "Exact 原文",
			toolCount: 1,
			formatVersion: 1,
			status: "disabled",
			revision: 1,
			installedAt: 1,
		};
		try {
			await put(
				storage,
				"hipi.tool-pack",
				{ value: record, packageText: `${packageText}\n`, interpreterVersion: 1 },
				digest,
			);
		} finally {
			await storage.close(context);
		}
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("getToolPackSource", { workspaceId: "work", digest }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		await runtime.close();
		const changed = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			await put(
				changed,
				"hipi.tool-pack",
				{ value: record, packageText: "x".repeat(65537), interpreterVersion: 1 },
				digest,
			);
			const meta = await changed.findDocument(
				{ kind: "hipi.conversation-metadata", scope: { kind: "session" }, key: scope.conversationId },
				"current",
				context,
			);
			assert.ok(meta);
			const doc = await changed.document(meta.id, "current", context);
			assert.ok(doc);
			const value = doc.value.value;
			assert.ok(value && typeof value === "object" && !Array.isArray(value));
			await put(
				changed,
				"hipi.conversation-metadata",
				{ value: { ...value, workspaceId: "foreign" } },
				scope.conversationId,
			);
		} finally {
			await changed.close(context);
		}
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("getToolPackSource", { workspaceId: "work", digest }), {
			code: "INDEX_RECOVERY_REQUIRED",
		});
		for (const method of ["listToolPackBindings", "listActiveToolPackBindings", "getToolActivities"] as const)
			await assert.rejects(runtime.call(method, scope), { code: "STORE_MISMATCH" });
		await runtime.close();
		const legacy = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			await put(legacy, "hipi.workspace-directory", {
				workspaceId: "work",
				name: "Work",
				generation: "preserved",
				initialized: false,
			});
			await put(legacy, "hipi.workspace", { workspaceId: "work", name: "Work", conversations: [] });
		} finally {
			await legacy.close(context);
		}
		runtime = await openTestRuntime(directory);
		await assert.rejects(
			runtime.call("getToolPackCommandResult", {
				workspaceId: "work",
				requestId: "missing",
				method: "installToolPack",
				requestDigest,
			}),
			{ code: "INDEX_RECOVERY_REQUIRED" },
		);
		await assert.rejects(runtime.call("listToolPacks", { workspaceId: "work" }), { code: "INDEX_RECOVERY_REQUIRED" });
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("pack cursors fence membership and reject another store while active bindings remain read-only", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-feature-pages-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Read",
		});
		const scope = { workspaceId: "work", conversationId: conversation.conversationId };
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			const record = await storage.findDocument(
				{ kind: "hipi.conversation-metadata", scope: { kind: "session" }, key: scope.conversationId },
				"current",
				context,
			);
			assert.ok(record);
			const doc = await storage.document(record.id, "current", context);
			const metadata = doc?.value.value;
			assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata));
			const durableId = metadata.durableId;
			assert.equal(typeof durableId, "number");
			const ids = Array.from({ length: 33 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
			await put(storage, "hipi.tool-pack-header", { count: ids.length, enabled: [], live: [] });
			await put(storage, "hipi.tool-pack-audit", { ids }, "packs-0");
			for (const digest of ids)
				await put(
					storage,
					"hipi.tool-pack",
					{
						interpreterVersion: 1,
						value: {
							workspaceId: "work",
							digest,
							packageId: "example.clean",
							version: "1.0.0",
							name: "Clean",
							description: "Exact 原文",
							toolCount: 1,
							formatVersion: 1,
							status: "disabled",
							revision: 1,
							installedAt: 1,
						},
					},
					digest,
				);
			const binding = {
				...scope,
				bindingId: "expired",
				digest,
				model: { provider: "faux", modelId: "faux-1" },
				expiresAt: 1,
				status: "active",
				revision: 1,
				createdAt: 0,
				disclosureVersion: 1,
				disclosed: true,
				purpose: "live-package",
			};
			await put(storage, "hipi.tool-pack-binding", { conversationId: durableId, value: binding }, "expired");
			await put(
				storage,
				"hipi.tool-pack-conversation",
				{ publicId: scope.conversationId, active: ["expired"], dependencies: [], count: 1 },
				String(durableId),
			);
			await put(storage, "hipi.tool-pack-audit", { ids: ["expired"] }, `bindings-${durableId}-0`);
			await put(
				storage,
				"hipi.tool-pack-command",
				{ value: { method: "bindToolPack", scope, requestDigest, result: binding }, resultId: "expired" },
				packCommandKey("work", "bind"),
			);
		} finally {
			await storage.close(context);
		}
		runtime = await openTestRuntime(directory);
		const first = await runtime.call("listToolPacks", { workspaceId: "work" });
		assert.equal(first.items.length, 32);
		assert.ok(first.nextCursor);
		const next = await runtime.call("listToolPacks", { workspaceId: "work", cursor: first.nextCursor });
		assert.equal(next.items.length, 1);
		assert.equal(next.nextCursor, null);
		assert.equal(new Set([...first.items, ...next.items].map((item) => item.digest)).size, 33);
		const forged: unknown[] = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
		forged[1] = "another-store-generation";
		await assert.rejects(
			runtime.call("listToolPacks", {
				workspaceId: "work",
				cursor: Buffer.from(JSON.stringify(forged)).toString("base64url"),
			}),
			{ code: "INVALID_REQUEST" },
		);
		assert.deepEqual(await runtime.call("listActiveToolPackBindings", scope), []);
		const history = await runtime.call("listToolPackBindings", scope);
		assert.equal(history.items[0].status, "active");
		assert.equal(history.items[0].revision, 1);
		const result = await runtime.call("getToolPackCommandResult", {
			...scope,
			requestId: "bind",
			method: "bindToolPack",
			requestDigest,
		});
		assert.equal(result?.result.revision, 1);
		await assert.rejects(
			runtime.call("getToolPackCommandResult", {
				workspaceId: "work",
				requestId: "bind",
				method: "installToolPack",
				requestDigest,
			}),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const previousVersion of [1, 2]) {
	test(`catalog ${previousVersion} upgrades to durable version 5 before runtime admission and retains identity/data`, async () => {
		// Catalog identity stores the canonical root, including macOS /private/var temporary paths.
		const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-catalog-v5-")));
		let runtime = await openTestRuntime(directory);
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Preserved" });
			const conversation = await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: "create",
				title: "Preserved",
			});
			const identity = await runtime.call("handshake", {});
			await runtime.close();
			const workspacePath = join(directory, "work", "workspace.sqlite");
			const workspaceBefore = await readFile(workspacePath);
			const database = new DatabaseSync(join(directory, "catalog.sqlite"));
			try {
				database.exec("DROP TABLE custom_providers; DROP TABLE provider_commands");
				database.prepare("UPDATE identity SET version=?").run(previousVersion);
			} finally {
				database.close();
			}
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("handshake", {}), identity);
			assert.deepEqual(
				await runtime.call("getConversation", { workspaceId: "work", conversationId: conversation.conversationId }),
				conversation,
			);
			await runtime.close();
			assert.deepEqual(await readFile(workspacePath), workspaceBefore);
			const upgraded = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
			try {
				const row = upgraded.prepare("SELECT version,store_id,root FROM identity WHERE singleton=1").get();
				assert.deepEqual({ ...row }, { version: 5, store_id: identity.storeId, root: directory });
				assert.equal(upgraded.prepare("SELECT count(*) AS count FROM custom_providers").get()?.count, 0);
				assert.equal(upgraded.prepare("SELECT count(*) AS count FROM provider_commands").get()?.count, 0);
				assert.equal(
					upgraded.prepare("SELECT name FROM workspaces WHERE workspace_id='work'").get()?.name,
					"Preserved",
				);
				// Exact version-admission policy from the shipped v4 source. This is not execution of its binary.
				assert.throws(
					() => {
						if (!row || (row.version !== 1 && row.version !== 2) || row.root !== directory)
							throw new AppError("STORE_MISMATCH");
					},
					{ code: "STORE_MISMATCH" },
				);
			} finally {
				upgraded.close();
			}
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("handshake", {}), identity);
			await runtime.close();
			// Version 4 is reserved for non-executing recovery archives; future schemas also stay untouched.
			for (const rejectedVersion of [4, 6, 999]) {
				const incompatible = new DatabaseSync(join(directory, "catalog.sqlite"));
				try {
					incompatible.prepare("UPDATE identity SET version=?").run(rejectedVersion);
				} finally {
					incompatible.close();
				}
				await assert.rejects(openTestRuntime(directory), { code: "STORE_MISMATCH" });
				const refused = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
				try {
					assert.equal(refused.prepare("SELECT version FROM identity").get()?.version, rejectedVersion);
					assert.equal(refused.prepare("SELECT store_id FROM identity").get()?.store_id, identity.storeId);
				} finally {
					refused.close();
				}
				assert.deepEqual(await readFile(workspacePath), workspaceBefore);
			}
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("catalog safety-fence write failure rejects runtime, preserves version 2 and releases the owner lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-v5-failure-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Preserved" });
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const workspacePath = join(directory, "work", "workspace.sqlite");
		const workspaceBefore = await readFile(workspacePath);
		const database = new DatabaseSync(join(directory, "catalog.sqlite"));
		try {
			database.exec(
				"DROP TABLE custom_providers; DROP TABLE provider_commands; UPDATE identity SET version=2; CREATE TRIGGER reject_safety_fence BEFORE UPDATE OF version ON identity WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'injected fence write failure'); END",
			);
		} finally {
			database.close();
		}
		await assert.rejects(openTestRuntime(directory), /injected fence write failure/);
		assert.deepEqual(await readFile(workspacePath), workspaceBefore);
		const failed = new DatabaseSync(join(directory, "catalog.sqlite"));
		try {
			assert.equal(failed.prepare("SELECT version FROM identity").get()?.version, 2);
			assert.equal(failed.prepare("SELECT store_id FROM identity").get()?.store_id, identity.storeId);
			assert.equal(
				failed
					.prepare(
						"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('custom_providers','provider_commands')",
					)
					.get()?.count,
				0,
			);
			failed.exec("DROP TRIGGER reject_safety_fence");
		} finally {
			failed.close();
		}
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		await runtime.close();
		const successful = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(successful.prepare("SELECT version FROM identity").get()?.version, 5);
			assert.equal(successful.prepare("SELECT count(*) AS count FROM custom_providers").get()?.count, 0);
			assert.equal(successful.prepare("SELECT count(*) AS count FROM provider_commands").get()?.count, 0);
		} finally {
			successful.close();
		}
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
