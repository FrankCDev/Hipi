import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PROTOCOL_VERSION } from "../src/contracts.ts";
import { openRuntime as openNodeRuntime } from "../src/node.ts";
import { PROJECT_SCHEMA } from "../src/projects/schema.ts";
import { SIDEBAR_PIN_SCHEMA } from "../src/sidebar-pins/schema.ts";
import { openTestRuntime } from "../src/testing.ts";

async function interruptCatalogTransaction(directory: string, signal: AbortSignal): Promise<void> {
	const child = fork(new URL("./catalog/fixtures/hot-journal-child.ts", import.meta.url), [directory], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	try {
		const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
		const [ready] = await Promise.race([
			once(child, "message", { signal: readinessSignal }),
			once(child, "exit", { signal: readinessSignal }).then(([code, signal]) => {
				throw new Error(`Catalog writer exited before spill: ${code}/${signal}`);
			}),
		]);
		assert.deepEqual(ready, { phase: "spilled", journalMode: "delete" });
		await assert.rejects(openTestRuntime(directory), { code: "WORKSPACE_BUSY" });
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			// Cleanup must finish even when the readiness deadline or test signal already aborted.
			const exited = once(child, "exit");
			assert.equal(child.kill("SIGKILL"), true);
			await exited;
		}
	}
	const journal = await readFile(join(directory, "catalog.sqlite-journal"));
	assert.ok(journal.length > 512);
	assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7", "a real hot journal must survive");
}

for (const state of ["healthy", "future", "archive-version", "recovery-state"] as const) {
	test(
		`owner-held catalog preflight rolls back an interrupted transaction and preserves ${state} fences`,
		{ timeout: 15000 },
		async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-journal-"));
			const runtime = await openTestRuntime(directory);
			try {
				await runtime.call("createWorkspace", { workspaceId: "committed", name: "Committed workspace" });
				const identity = await runtime.call("handshake", {});
				await runtime.close();
				const catalogPath = join(directory, "catalog.sqlite");
				const database = new DatabaseSync(catalogPath);
				try {
					if (state === "future") database.exec("UPDATE identity SET version=999");
					if (state === "archive-version") database.exec("UPDATE identity SET version=4");
					if (state === "recovery-state") database.exec("CREATE TABLE recovery_state (marker TEXT)");
				} finally {
					database.close();
				}
				const committedCatalog = await readFile(catalogPath);
				const workspacePath = join(directory, "committed", "workspace.sqlite");
				const committedWorkspace = await readFile(workspacePath);
				await interruptCatalogTransaction(directory, t.signal);
				if (state === "healthy") {
					const reopened = await openTestRuntime(directory);
					try {
						assert.deepEqual(await reopened.call("handshake", {}), identity);
						assert.deepEqual(await reopened.call("listWorkspaces", {}), {
							items: [{ workspaceId: "committed", name: "Committed workspace" }],
							nextCursor: null,
						});
					} finally {
						await reopened.close();
					}
				} else {
					await assert.rejects(openTestRuntime(directory), { code: "STORE_MISMATCH" });
					// Physical rollback restores committed bytes; rejection must not migrate or reset them.
					assert.deepEqual(await readFile(catalogPath), committedCatalog);
				}
				const inspected = new DatabaseSync(catalogPath, { readOnly: true });
				try {
					assert.equal(inspected.prepare("SELECT store_id FROM identity").get()?.store_id, identity.storeId);
					assert.equal(inspected.prepare("SELECT count(*) AS count FROM workspaces").get()?.count, 1);
				} finally {
					inspected.close();
				}
				assert.deepEqual(await readFile(workspacePath), committedWorkspace);
			} finally {
				await runtime.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
}

test("corrupt catalog preflight fails closed without replacing catalog or committed workspace bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-corrupt-"));
	const runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "committed", name: "Committed workspace" });
		await runtime.close();
		const catalogPath = join(directory, "catalog.sqlite");
		const corrupt = Buffer.from("Not a SQLite catalog");
		await writeFile(catalogPath, corrupt);
		const workspacePath = join(directory, "committed", "workspace.sqlite");
		const committedWorkspace = await readFile(workspacePath);
		await assert.rejects(openTestRuntime(directory), { code: "ERR_SQLITE_ERROR", errcode: 26 });
		assert.deepEqual(await readFile(catalogPath), corrupt);
		assert.deepEqual(await readFile(workspacePath), committedWorkspace);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const point of ["after_reserve", "after_directory", "after_storage", "before_ready"] as const) {
	test(`catalog recovers interrupted creation at ${point} without deleting original data`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-failure-"));
		let runtime = await openTestRuntime(directory, {
			catalogFailpoint: async (current) => {
				if (current === point) throw new Error("Injected catalog interruption");
			},
		});
		try {
			const identity = await runtime.call("handshake", {});
			await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), /Injected/);
			await runtime.close();
			runtime = await openTestRuntime(directory);
			assert.deepEqual(await runtime.call("handshake", {}), identity);
			await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Changed" }), {
				code: "IDEMPOTENCY_CONFLICT",
			});
			assert.deepEqual(await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), {
				workspaceId: "work",
				name: "Original",
			});
			assert.deepEqual(await runtime.call("listWorkspaces", {}), {
				items: [{ workspaceId: "work", name: "Original" }],
				nextCursor: null,
			});
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("persistent identity and bounded catalogs survive restart; listings never resume PI scheduling", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-"));
	let runtime = await openTestRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("Accepted but paused");
		},
	});
	try {
		const identity = await runtime.call("handshake", {});
		assert.deepEqual(await runtime.call("listWorkspaces", {}), { items: [], nextCursor: null });
		assert.equal(
			(await readdir(directory)).some((name) => name === "work"),
			false,
		);
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Workspace" });
		const conversation = await runtime.call("createConversation", {
			requestId: "create-1",
			workspaceId: "work",
			title: "Saved conversation",
		});
		await assert.rejects(
			runtime.call("submit", {
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: "pending",
				text: "Do not run from a listing",
			}),
			/Accepted/,
		);
		await runtime.close();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openNodeRuntime(directory, {
			models,
			model: { provider: "faux", modelId: "faux-1" },
			resume: true,
		});
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		assert.deepEqual(await runtime.call("listWorkspaces", {}), {
			items: [{ workspaceId: "work", name: "Workspace" }],
			nextCursor: null,
		});
		assert.deepEqual(await runtime.call("listConversations", { workspaceId: "work" }), {
			items: [conversation],
			nextCursor: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(faux.state.callCount, 0);
		await assert.rejects(runtime.call("listConversations", { workspaceId: "../work" }), { code: "INVALID_REQUEST" });
		await assert.rejects(runtime.call("listConversations", { workspaceId: "missing" }), { code: "NOT_FOUND" });
		await assert.rejects(
			runtime.execute({
				version: PROTOCOL_VERSION,
				method: "listWorkspaces",
				params: {},
				expectedStoreId: "another-store",
			}),
			{ code: "STORE_MISMATCH" },
		);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("pre-project schema10 workspace discovery repairs registration without replacing its PI conversation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-discovery-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "legacy", name: "Legacy" });
		const conversation = await runtime.call("createConversation", {
			requestId: "create-2",
			workspaceId: "legacy",
			title: "Preserved",
		});
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const physicalBefore = await readFile(join(directory, "legacy", "workspace.sqlite"));
		const db = new DatabaseSync(join(directory, "catalog.sqlite"));
		// Simulate the historical catalog before project/mixed-pin authority existed. Derive
		// exactly those feature tables from their schema definitions, retaining every older table.
		for (const schema of [SIDEBAR_PIN_SCHEMA, PROJECT_SCHEMA])
			for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g))
				db.exec(`DROP TABLE ${match[1]}`);
		db.exec("UPDATE identity SET version=10");
		db.exec("DELETE FROM workspaces");
		db.close();
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("handshake", {}), identity);
		assert.deepEqual(await runtime.call("listConversations", { workspaceId: "legacy" }), {
			items: [conversation],
			nextCursor: null,
		});
		assert.equal((await runtime.call("getProject", { projectId: "legacy" })).homeWorkspaceId, "legacy");
		await runtime.close();
		assert.deepEqual(await readFile(join(directory, "legacy", "workspace.sqlite")), physicalBefore);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("schema12 lost registration cannot silently reconstruct authoritative logical history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-registration-loss-"));
	const runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "registered", name: "Registered" });
		assert.equal((await runtime.call("getProject", { projectId: "registered" })).homeWorkspaceId, "registered");
		await runtime.close();
		const catalogPath = join(directory, "catalog.sqlite");
		const db = new DatabaseSync(catalogPath);
		try {
			assert.equal(db.prepare("SELECT version FROM identity").get()?.version, 12);
			db.exec("DELETE FROM workspaces");
		} finally {
			db.close();
		}
		const catalogBefore = await readFile(catalogPath);
		const physicalPath = join(directory, "registered", "workspace.sqlite");
		const physicalBefore = await readFile(physicalPath);
		await assert.rejects(openTestRuntime(directory), { code: "STORE_MISMATCH" });
		assert.deepEqual(await readFile(catalogPath), catalogBefore);
		assert.deepEqual(await readFile(physicalPath), physicalBefore);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("copied roots, workspace symlinks and database symlinks cannot impersonate a store", async () => {
	const parent = await mkdtemp(join(tmpdir(), "hipi-catalog-path-"));
	const directory = join(parent, "original");
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" });
		await runtime.close();
		await cp(directory, join(parent, "copy"), { recursive: true });
		await assert.rejects(openTestRuntime(join(parent, "copy")), { code: "STORE_MISMATCH" });
		runtime = await openTestRuntime(directory);
		await symlink(join(parent, "copy", "work"), join(directory, "escape"), "dir");
		await assert.rejects(runtime.call("createWorkspace", { workspaceId: "escape", name: "Escape" }), {
			code: "NOT_FOUND",
		});
		await mkdir(join(directory, "linked"));
		await symlink(join(parent, "copy", "work", "workspace.sqlite"), join(directory, "linked", "workspace.sqlite"));
		await assert.rejects(runtime.call("openWorkspace", { workspaceId: "linked" }), { code: "INVALID_REQUEST" });
	} finally {
		await runtime.close();
		await rm(parent, { recursive: true, force: true });
	}
});

test("a registered workspace with a missing database is never silently recreated", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-missing-"));
	let runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Original" });
		await runtime.close();
		await rm(join(directory, "work", "workspace.sqlite"));
		runtime = await openTestRuntime(directory);
		await assert.rejects(runtime.call("createWorkspace", { workspaceId: "work", name: "Original" }), {
			code: "NOT_FOUND",
		});
		assert.equal((await readdir(join(directory, "work"))).includes("workspace.sqlite"), false);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("close drains admitted initialization and metadata queries before releasing the root owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-close-"));
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let runtime = await openTestRuntime(directory, {
		catalogFailpoint: async (point) => {
			if (point === "before_ready") {
				entered.resolve();
				await gate.promise;
			}
		},
	});
	try {
		const creating = runtime.call("createWorkspace", { workspaceId: "work", name: "Admitted" });
		await entered.promise;
		const closing = runtime.close();
		await assert.rejects(openTestRuntime(directory), { code: "WORKSPACE_BUSY" });
		await assert.rejects(runtime.call("handshake", {}), { code: "CLOSED" });
		gate.resolve();
		await creating;
		await closing;
		runtime = await openTestRuntime(directory);
		const conversation = await runtime.call("createConversation", {
			requestId: "create-3",
			workspaceId: "work",
			title: "Preserved",
		});
		const reading = runtime.call("listConversations", { workspaceId: "work" });
		await runtime.close();
		assert.deepEqual(await reading, { items: [conversation], nextCursor: null });
		runtime = await openTestRuntime(directory);
		assert.deepEqual(await runtime.call("listWorkspaces", {}), {
			items: [{ workspaceId: "work", name: "Admitted" }],
			nextCursor: null,
		});
	} finally {
		gate.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent idle workspace creation preserves the full catalog beyond the live cache limit across restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-limit-"));
	let runtime = await openTestRuntime(directory);
	try {
		const expected = Array.from({ length: 20 }, (_, i) => ({ workspaceId: `work_${i}`, name: `Workspace ${i}` }));
		// Idle eviction permits admission beyond the live cache bound; workspace-cache tests enforce that bound.
		const created = await Promise.all(expected.map((workspace) => runtime.call("createWorkspace", workspace)));
		assert.deepEqual(created, expected);
		const before = await runtime.call("listWorkspaces", {});
		assert.equal(before.nextCursor, null);
		assert.deepEqual(
			before.items.toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
			expected.toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
		);
		await runtime.close();
		runtime = await openTestRuntime(directory);
		const listed = await runtime.call("listWorkspaces", {});
		assert.deepEqual(listed, before);
		for (const workspace of expected)
			assert.deepEqual(await runtime.call("getWorkspace", { workspaceId: workspace.workspaceId }), workspace);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("unknown catalog schema is rejected without resetting the identity or deleting workspace data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-catalog-version-"));
	const runtime = await openTestRuntime(directory);
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Preserved" });
		const identity = await runtime.call("handshake", {});
		await runtime.close();
		const database = new DatabaseSync(join(directory, "catalog.sqlite"));
		try {
			database.exec("UPDATE identity SET version=999");
		} finally {
			database.close();
		}
		await assert.rejects(openTestRuntime(directory), { code: "STORE_MISMATCH" });
		const inspected = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(inspected.prepare("SELECT store_id FROM identity").get()?.store_id, identity.storeId);
			assert.equal(inspected.prepare("SELECT name FROM workspaces").get()?.name, "Preserved");
		} finally {
			inspected.close();
		}
		assert.ok((await readdir(join(directory, "work"))).includes("workspace.sqlite"));
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
