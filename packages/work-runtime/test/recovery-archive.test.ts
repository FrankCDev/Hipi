import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createFileAuthority } from "../src/files/service.ts";
import { openRecoveryArchive } from "../src/maintenance/archive.ts";
import { archiveDocument } from "../src/maintenance/archive-history.ts";
import { backupStore } from "../src/maintenance/backup.ts";
import { type RestorePhase, restoreStore, restoreStoreForTest } from "../src/maintenance/restore.ts";
import { verifyBackup } from "../src/maintenance/verify.ts";
import { openRuntime } from "../src/node.ts";
import { openTestRuntime } from "../src/testing.ts";

async function fixture() {
	// System tmpdir can have symlink ancestors; derive maintenance paths from the real fixture root.
	const root = await realpath(await mkdtemp(join(tmpdir(), "hipi-recovery-")));
	const source = join(root, "source");
	await mkdir(source);
	const runtime = await openTestRuntime(source, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("paused snapshot");
		},
	});
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Historical workspace" });
	const conversation = await runtime.call("createConversation", {
		workspaceId: "work",
		requestId: "create",
		title: "Historical task",
	});
	await assert.rejects(
		runtime.call("submit", {
			workspaceId: "work",
			conversationId: conversation.conversationId,
			requestId: "pending",
			text: "Snapshot text",
		}),
		/paused snapshot/,
	);
	await runtime.close();
	const backup = join(root, "backup");
	await backupStore({ source, destination: backup });
	return { root, source, backup, conversation };
}

test("new archive identities; repeated read-only browse and export; old runtime rejected", async () => {
	const f = await fixture();
	try {
		const original = await readFile(join(f.source, "work", "workspace.sqlite"));
		const a = await restoreStore({ source: f.backup, destination: join(f.root, "archive-a") });
		const b = await restoreStore({ source: f.backup, destination: join(f.root, "archive-b") });
		assert.notEqual(a.storeId, b.storeId);
		for (let restart = 0; restart < 2; restart++) {
			const archive = await openRecoveryArchive({ directory: a.directory });
			try {
				assert.equal(archive.info.readOnly, true);
				const scope = { storeId: a.storeId, workspaceId: "work", conversationId: f.conversation.conversationId };
				assert.equal((await archive.listWorkspaces({ storeId: a.storeId })).items.length, 1);
				assert.equal((await archive.listConversations(scope)).items[0].title, "Historical task");
				await archive.getHistory(scope);
				const output = join(f.root, `export-${restart}.jsonl`);
				await archive.exportHistory({ ...scope, destination: output });
				assert.match(await readFile(output, "utf8"), /Historical snapshot only/);
				await assert.rejects(archive.exportHistory({ ...scope, destination: output }), { code: "EEXIST" });
				await assert.rejects(archive.getHistory({ ...scope, storeId: b.storeId }), { code: "STORE_MISMATCH" });
				const foreign = Buffer.from(
					JSON.stringify({ v: 1, storeId: b.storeId, scope: "workspaces", after: "" }),
				).toString("base64url");
				await assert.rejects(archive.listWorkspaces({ storeId: a.storeId, cursor: foreign }), {
					code: "INVALID_REQUEST",
				});
				assert.equal("continueWorkspace" in archive, false);
			} finally {
				await archive.close();
			}
		}
		await assert.rejects(openTestRuntime(a.directory), { code: "STORE_MISMATCH" });
		assert.deepEqual(await readFile(join(f.source, "work", "workspace.sqlite")), original);
		await verifyBackup({ directory: f.backup });
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
for (const point of [
	"prepare_catalog",
	"copy_workspaces",
	"verify_target",
	"sync_payload",
	"commit_ready",
] satisfies RestorePhase[])
	test(`failure at ${point}: preparing is sealed, originals intact`, async () => {
		const f = await fixture();
		const target = join(f.root, "failed");
		try {
			const before = await readFile(join(f.backup, "manifest.json"));
			await assert.rejects(
				restoreStoreForTest({ source: f.backup, destination: target }, async (phase) => {
					if (phase === point) throw new Error("injected");
				}),
			);
			await assert.rejects(openRecoveryArchive({ directory: target }));
			await assert.rejects(openTestRuntime(target), { code: "STORE_MISMATCH" });
			await assert.rejects(restoreStore({ source: f.backup, destination: target }), { code: "TARGET_EXISTS" });
			assert.deepEqual(await readFile(join(f.backup, "manifest.json")), before);
			await verifyBackup({ directory: f.backup });
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
test("real competitor creates schema3 and releases lock before restore acquires; no overwrite", async () => {
	const f = await fixture();
	const target = join(f.root, "raced");
	try {
		await assert.rejects(
			restoreStoreForTest({ source: f.backup, destination: target }, async (phase, directory) => {
				if (phase !== "allocate_target") return;
				const script = join(f.root, "competitor.mjs");
				await writeFile(
					script,
					`import { DatabaseSync } from 'node:sqlite';import {join} from 'node:path';const owner=new DatabaseSync(join(process.argv[2],'store-owner.sqlite'));owner.exec('BEGIN EXCLUSIVE');const db=new DatabaseSync(join(process.argv[2],'catalog.sqlite'));db.exec('CREATE TABLE identity(version INTEGER);INSERT INTO identity VALUES(3)');db.close();owner.close();`,
				);
				await new Promise<void>((resolve, reject) => {
					const child = spawn(process.execPath, [script, directory], { stdio: "pipe" });
					child.on("error", reject);
					child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}`))));
				});
			}),
			{ code: "TARGET_EXISTS" },
		);
		const db = new DatabaseSync(join(target, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(db.prepare("SELECT version FROM identity").get()?.version, 3);
		} finally {
			db.close();
		}
		assert.deepEqual((await readdir(target)).sort(), ["catalog.sqlite", "store-owner.sqlite"]);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
test("ready archive refuses changed payload; zero-byte competitor is preserved", async () => {
	const f = await fixture();
	try {
		const target = join(f.root, "zero");
		await assert.rejects(
			restoreStoreForTest({ source: f.backup, destination: target }, async (phase, root) => {
				if (phase === "allocate_target") await writeFile(join(root, "catalog.sqlite"), "");
			}),
			{ code: "TARGET_EXISTS" },
		);
		assert.equal((await readFile(join(target, "catalog.sqlite"))).length, 0);
		const restored = await restoreStore({ source: f.backup, destination: join(f.root, "good") });
		await writeFile(join(restored.directory, "work", "workspace.sqlite"), "corrupt");
		await assert.rejects(openRecoveryArchive({ directory: restored.directory }));
		await verifyBackup({ directory: f.backup });
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

for (const outcome of ["pending", "unknown"] as const)
	test(`${outcome} snapshot remains historical after external effects; reads never execute or reconcile`, async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "hipi-recovery-effect-")));
		const source = join(root, "source");
		const filesRoot = join(root, "files");
		await mkdir(filesRoot);
		await writeFile(join(filesRoot, "note.txt"), "before");
		const authority = createFileAuthority({
			securityMode: "cooperative-local-files",
			assertWorkspaceAccess: async () => {},
		});
		const grant = await authority.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: filesRoot,
			writable: true,
		});
		const files = authority.forAgent("owner");
		const current = await files.readText({ ...grant, path: "note.txt" });
		let effects = 0;
		const faux = fauxProvider({
			provider: "faux",
			api: "recovery-test",
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
			tokensPerSecond: 100000,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"hipi_files_save",
						{ rootId: grant.rootId, path: "note.txt", text: "after", ifMatch: current.revision },
						{ id: "save" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Saved"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const options = {
			models,
			model: { provider: "faux", modelId: "faux-1" },
			agentFiles: () => ({
				...files,
				saveText: async (...args: Parameters<typeof files.saveText>) => {
					effects++;
					const result = await files.saveText(...args);
					if (outcome === "unknown") throw new Error("Lost effect acknowledgement");
					return result;
				},
			}),
		};
		const runtime = await openRuntime(source, options);
		const wait = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const result = await read();
				if (result !== undefined) return result;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error("Timed out");
		};
		try {
			await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
			const conversation = await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: "create",
				title: "Effect",
			});
			const scope = { workspaceId: "work", conversationId: conversation.conversationId };
			await runtime.call("authorizeAgentContext", {
				...scope,
				requestId: "grant",
				rootId: grant.rootId,
				pathPrefixes: [""],
				model: options.model,
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			});
			await runtime.call("submit", { ...scope, requestId: "input", text: "Save" });
			const approval = await wait(async () => (await runtime.call("listToolApprovals", scope)).items[0]);
			assert.equal(approval.status, "pending");
			assert.equal(effects, 0);
			if (outcome === "unknown") {
				await runtime.call("decideToolApproval", {
					...scope,
					requestId: "approve",
					approvalId: approval.approvalId,
					expectedRevision: approval.revision,
					argumentsDigest: approval.argumentsDigest,
					contentDigest: approval.contentDigest,
					decision: "approve",
				});
				await wait(async () => {
					const page = await runtime.call("getToolActivities", scope);
					return page.items.find((item) => item.effect?.status === "unknown" && item.phase === "terminal");
				});
				await wait(async () => {
					const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "input" });
					return receipt?.execution === "done" || receipt?.execution === "unanswered" ? receipt : undefined;
				});
				assert.equal(effects, 1);
			}
			await runtime.close();
			const backup = join(root, "backup");
			await backupStore({ source, destination: backup });
			// The outside world can change after a snapshot, without a corresponding durable receipt.
			effects++;
			await writeFile(join(filesRoot, "note.txt"), "after");
			const callsBeforeRestore = faux.state.callCount;
			const effectsBeforeRestore = effects;
			const restored = await restoreStore({ source: backup, destination: join(root, "archive") });
			const second = await restoreStore({ source: backup, destination: join(root, "archive-second") });
			const payloadBefore = await readFile(join(restored.directory, "work", "workspace.sqlite"));
			for (let i = 0; i < 2; i++) {
				const archive = await openRecoveryArchive({ directory: restored.directory });
				try {
					await archive.getHistory({ ...scope, storeId: restored.storeId });
					const activities = await archive.getToolActivities({ ...scope, storeId: restored.storeId });
					assert.equal(activities.evidence, "snapshot_only");
					assert.equal(activities.readOnly, true);
					assert.equal(activities.snapshotAt, archive.info.snapshotAt);
					const activity = activities.items.find((item) => item.toolName === "hipi_files_save");
					assert.ok(activity);
					if (outcome === "pending") {
						assert.equal(activity.approval?.status, "pending");
						assert.equal(activity.effect, undefined);
					} else {
						assert.equal(activity.effect?.status, "unknown");
						assert.equal(activity.textAvailable, true);
						const text = await archive.getToolActivityText({
							...scope,
							storeId: restored.storeId,
							activityId: activity.activityId,
						});
						assert.equal(text.evidence, "snapshot_only");
						assert.equal(text.retainedOutputOnly, true);
						// Failure diagnostics are intentionally not exposed as retained tool output.
						assert.equal(text.text, "");
					}
					assert.equal("arguments" in activity, false);
					assert.equal("beforeText" in activity, false);
					assert.equal("afterText" in activity, false);
					assert.ok(activities.nextCursor);
					const other = await openRecoveryArchive({ directory: second.directory });
					try {
						await assert.rejects(
							other.getToolActivities({ ...scope, storeId: second.storeId, cursor: activities.nextCursor }),
							{ code: "INVALID_REQUEST" },
						);
					} finally {
						await other.close();
					}
					await archive.exportHistory({
						...scope,
						storeId: restored.storeId,
						destination: join(root, `effect-${i}.jsonl`),
					});
				} finally {
					await archive.close();
				}
			}
			assert.equal(effects, effectsBeforeRestore);
			assert.deepEqual(await readFile(join(restored.directory, "work", "workspace.sqlite")), payloadBefore);
			assert.equal(faux.state.callCount, callsBeforeRestore);
			assert.equal(await readFile(join(filesRoot, "note.txt"), "utf8"), "after");
		} finally {
			await runtime.close();
			await authority.close();
			await rm(root, { recursive: true, force: true });
		}
	});

for (const sql of ["DELETE FROM archive_conversations", "UPDATE archive_conversations SET durable_id=999999"])
	test(`archive rejects valid SQLite index tampering: ${sql}`, async () => {
		const f = await fixture();
		try {
			const restored = await restoreStore({ source: f.backup, destination: join(f.root, "archive") });
			const db = new DatabaseSync(join(restored.directory, "catalog.sqlite"));
			try {
				db.exec(sql);
			} finally {
				db.close();
			}
			await assert.rejects(openRecoveryArchive({ directory: restored.directory }), { code: "IDENTITY_MISMATCH" });
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});

test("mixed-case workspace order matches SQLite; empty archive cannot be laundered through lost identity", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "hipi-recovery-catalog-")));
	try {
		const source = join(root, "source");
		const runtime = await openTestRuntime(source);
		await runtime.call("createWorkspace", { workspaceId: "Z", name: "Upper" });
		await runtime.call("createWorkspace", { workspaceId: "a", name: "Lower" });
		await runtime.close();
		const backup = join(root, "backup");
		await backupStore({ source, destination: backup });
		const restored = await restoreStore({ source: backup, destination: join(root, "archive") });
		const archive = await openRecoveryArchive({ directory: restored.directory });
		try {
			assert.deepEqual(
				(await archive.listWorkspaces({ storeId: restored.storeId })).items.map((w) => w.workspaceId),
				["Z", "a"],
			);
		} finally {
			await archive.close();
		}
		const empty = join(root, "empty");
		const emptyRuntime = await openTestRuntime(empty);
		await emptyRuntime.close();
		await backupStore({ source: empty, destination: join(root, "empty-backup") });
		for (const sql of ["DELETE FROM identity", "DROP TABLE identity"]) {
			const target = await restoreStore({
				source: join(root, "empty-backup"),
				destination: join(root, sql.startsWith("DROP") ? "drop" : "delete"),
			});
			const path = join(target.directory, "catalog.sqlite");
			const db = new DatabaseSync(path);
			try {
				db.exec(sql);
			} finally {
				db.close();
			}
			const bytes = await readFile(path);
			await assert.rejects(openTestRuntime(target.directory), { code: "STORE_MISMATCH" });
			assert.deepEqual(await readFile(path), bytes);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("export is exclusive, has completion marker, guards owner across awaits and refuses internal output", async () => {
	const f = await fixture();
	try {
		const restored = await restoreStore({ source: f.backup, destination: join(f.root, "archive") });
		const archive = await openRecoveryArchive({ directory: restored.directory });
		const scope = { storeId: restored.storeId, workspaceId: "work", conversationId: f.conversation.conversationId };
		try {
			await assert.rejects(archive.exportHistory({ ...scope, destination: join(restored.directory, "output") }), {
				code: "INVALID_PATH",
			});
			const destination = join(f.root, "export.jsonl");
			const pending = archive.exportHistory({ ...scope, destination });
			await assert.rejects(archive.close(), { code: "BUSY" });
			await pending;
			assert.equal(
				JSON.parse((await readFile(destination, "utf8")).trim().split("\n").at(-1) ?? "{}").type,
				"complete",
			);
			const failed = join(f.root, "failed.jsonl");
			await assert.rejects(archive.exportHistory({ ...scope, conversationId: "missing", destination: failed }));
			assert.doesNotMatch(await readFile(failed, "utf8"), /"type":"complete"/);
		} finally {
			await archive.close();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("manifest digest binds exactly saved recovery bytes and detects edits", async () => {
	const f = await fixture();
	try {
		const restored = await restoreStore({ source: f.backup, destination: join(f.root, "archive") });
		const path = join(restored.directory, "recovery-manifest.json");
		const bytes = await readFile(path);
		const value = JSON.parse(bytes.toString("utf8"));
		const catalog = new DatabaseSync(join(restored.directory, "catalog.sqlite"), { readOnly: true });
		try {
			assert.equal(
				catalog.prepare("SELECT manifest_digest FROM recovery_state").get()?.manifest_digest,
				createHash("sha256").update(bytes).digest("hex"),
			);
		} finally {
			catalog.close();
		}
		assert.equal(value.sourceBackupManifestDigest, (await verifyBackup({ directory: f.backup })).manifestDigest);
		await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")]));
		await assert.rejects(openRecoveryArchive({ directory: restored.directory }), { code: "INTEGRITY_FAILED" });
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("failed PI native close retains target ownership until the maintenance child exits", async () => {
	const f = await fixture();
	const target = join(f.root, "failed-close");
	const script = join(f.root, "failed-close.mjs");
	const restoreUrl = new URL("../src/maintenance/restore.ts", import.meta.url).href;
	await writeFile(
		script,
		`import {DatabaseSync} from 'node:sqlite';import {restoreStoreForTest} from ${JSON.stringify(restoreUrl)};
const original=DatabaseSync.prototype.close;let inject=false;
DatabaseSync.prototype.close=function(){if(inject){inject=false;throw new Error('injected native close');}return original.call(this);};
try{await restoreStoreForTest({source:process.argv[2],destination:process.argv[3]},async phase=>{if(phase==='prepare_catalog')inject=true;});process.exit(2);}catch{process.stdout.write('retained\\n');}setInterval(()=>{},1000);`,
	);
	const child = spawn(process.execPath, ["--conditions=source", script, f.backup, target], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", () => resolve());
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`premature exit ${code}`)));
		});
		await assert.rejects(openTestRuntime(target), { code: "WORKSPACE_BUSY" });
	} finally {
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await rm(f.root, { recursive: true, force: true });
	}
});

test("streaming export spans multiple entry pages in strict chronological model order with complete Unicode text", async () => {
	const f = await fixture();
	try {
		const storage = await openNodeSqliteStorage(join(f.source, "work", "workspace.sqlite"));
		const expected: { id: string; text: string }[] = [];
		try {
			const metadata = (await archiveDocument(storage, "hipi.conversation-metadata", f.conversation.conversationId))
				?.value;
			assert.ok(
				metadata &&
					typeof metadata === "object" &&
					!Array.isArray(metadata) &&
					typeof metadata.durableId === "number",
			);
			for (let n = 0; n < 70; n++) {
				const id = await storage.mintId<EntryId>();
				const user = `user ${n}`;
				const assistant = n === 69 ? `final ${"界😀".repeat(18000)} tail` : `assistant ${n}`;
				await storage.commit(
					[
						{
							type: "entry",
							value: {
								id,
								conversationId: metadata.durableId as ConversationId,
								kind: "pi.user",
								data: {},
								model: [{ role: "user", content: user, timestamp: n }, fauxAssistantMessage(assistant)],
							},
						},
					],
					context,
				);
				expected.push({ id: `${id}_0`, text: user }, { id: `${id}_1`, text: assistant });
			}
		} finally {
			await storage.close(context);
		}
		const backup = join(f.root, "history-backup");
		await backupStore({ source: f.source, destination: backup });
		const restored = await restoreStore({ source: backup, destination: join(f.root, "history-archive") });
		const archive = await openRecoveryArchive({ directory: restored.directory });
		const output = join(f.root, "chronological.jsonl");
		try {
			const result = await archive.exportHistory({
				storeId: restored.storeId,
				workspaceId: "work",
				conversationId: f.conversation.conversationId,
				destination: output,
			});
			assert.equal(result.messages, expected.length);
		} finally {
			await archive.close();
		}
		const records: {
			type: string;
			id?: string;
			messageId?: string;
			text?: string;
			offset?: number;
			nextOffset?: number | null;
			order?: string;
			messages?: number;
		}[] = (await readFile(output, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(records[0].order, "chronological");
		assert.deepEqual(
			records.filter((r) => r.type === "message").map((r) => r.id),
			expected.map((r) => r.id),
		);
		for (const message of expected) {
			const chunks = records.filter((r) => r.type === "text" && r.messageId === message.id);
			assert.equal(chunks.map((r) => r.text).join(""), message.text);
			assert.equal(chunks.at(-1)?.nextOffset, null);
			let offset = 0;
			for (const chunk of chunks) {
				assert.equal(chunk.offset, offset);
				assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text ?? ""));
				offset += (chunk.text ?? "").length;
			}
		}
		assert.deepEqual(records.at(-1), { type: "complete", messages: expected.length });
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
