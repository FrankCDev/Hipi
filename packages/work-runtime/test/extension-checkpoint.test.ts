import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	PackAuditDoc,
	PackBindingDoc,
	PackCommandDoc,
	PackConversationDoc,
	PackDoc,
	PackHeaderDoc,
	PackIdentityDoc,
} from "../src/extensions/lifecycle-store.ts";
import { parseToolPack } from "../src/extensions/pack.ts";
import { openTestRuntime } from "../src/testing.ts";

async function stored(storage: Storage, kind: string, key?: string) {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
		"current",
		context,
	);
	assert.ok(record);
	const value = await storage.document(record.id, "current", context);
	assert.ok(value);
	assert.ok(value.deltasSinceBase < 32, `${kind} has ${value.deltasSinceBase} cold deltas`);
	return value;
}

test("SQLite cold package reads stay paged after 100 disabled installs and retain exact source", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-pack-checkpoint-"));
	let runtime = await openTestRuntime(directory);
	const sources = new Map<string, string>();
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
		for (let index = 0; index < 100; index++) {
			const packageText = JSON.stringify(
				{
					formatVersion: 1,
					id: "example.cleanup",
					version: `1.0.${index}`,
					name: "Cleanup",
					description: "Exact 原文",
					tools: [{ id: "clean", name: "Clean", description: "Trim", pipeline: [{ op: "trimLineEnds" }] }],
				},
				null,
				2,
			);
			const digest = parseToolPack(Buffer.from(packageText)).digest;
			sources.set(digest, packageText);
			const pack = await runtime.call("installToolPack", {
				workspaceId: "work",
				requestId: `install-${index}`,
				packageText,
				expectedDigest: digest,
				disclosureVersion: 1,
			});
			assert.equal(pack.status, "disabled");
		}
		await runtime.close();
		const storage = await openNodeSqliteStorage(join(directory, "work", "workspace.sqlite"));
		try {
			const header = await stored(storage, "hipi.tool-pack-header");
			assert.equal(header.value.count, 100);
			assert.deepEqual(header.value.enabled, []);
			assert.deepEqual(header.value.live, []);
			await stored(storage, "hipi.tool-pack-audit", "packs-0");
			await stored(storage, "hipi.tool-pack-audit", "packs-1");
		} finally {
			await storage.close(context);
		}
		runtime = await openTestRuntime(directory, { resume: true });
		let cursor: string | undefined;
		const seen = new Set<string>();
		do {
			const page = await runtime.call("listToolPacks", { workspaceId: "work", ...(cursor ? { cursor } : {}) });
			assert.ok(page.items.length <= 32);
			for (const pack of page.items) {
				seen.add(pack.digest);
				const source = await runtime.call("getToolPackSource", { workspaceId: "work", digest: pack.digest });
				assert.equal(source.packageText, sources.get(pack.digest));
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(seen.size, 100);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("every lifecycle document checkpoints repeated updates while preserving current values", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-pack-docs-"));
	const path = join(directory, "workspace.sqlite");
	let storage = await openNodeSqliteStorage(path);
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		for (let index = 1; index <= 100; index++) {
			await harness.commit(async (tx) => {
				(await tx.doc(PackHeaderDoc)).count = index;
				(await tx.doc(PackConversationDoc, "chat", null)).count = index;
				(await tx.doc(PackAuditDoc, "test", null)).ids = [String(index)];
				(await tx.doc(PackBindingDoc, "binding", null)).conversationId = index;
				(await tx.doc(PackDoc, "pack", null)).packageText = `exact source ${index}`;
				(await tx.doc(PackIdentityDoc, "identity", null)).digest = String(index);
				(await tx.doc(PackCommandDoc, "command", null)).resultId = String(index);
			}, context);
		}
		await harness.close(context);
		storage = await openNodeSqliteStorage(path);
		for (const [kind, key] of [
			["hipi.tool-pack-header", undefined],
			["hipi.tool-pack-conversation", "chat"],
			["hipi.tool-pack-audit", "test"],
			["hipi.tool-pack-binding", "binding"],
			["hipi.tool-pack", "pack"],
			["hipi.tool-pack-identity", "identity"],
			["hipi.tool-pack-command", "command"],
		] as const) {
			const current = await stored(storage, kind, key);
			assert.equal(current.deltasSinceBase, 3);
			const expected =
				kind === "hipi.tool-pack-header"
					? { count: 100, enabled: [], live: [] }
					: kind === "hipi.tool-pack-conversation"
						? { publicId: "", active: [], dependencies: [], count: 100 }
						: kind === "hipi.tool-pack-audit"
							? { ids: ["100"] }
							: kind === "hipi.tool-pack-binding"
								? { conversationId: 100 }
								: kind === "hipi.tool-pack"
									? { interpreterVersion: 1, packageText: "exact source 100" }
									: kind === "hipi.tool-pack-identity"
										? { digest: "100" }
										: { resultId: "100" };
			assert.deepEqual(current.value, expected);
		}
		assert.equal((await stored(storage, "hipi.tool-pack", "pack")).value.packageText, "exact source 100");
	} finally {
		await harness.close(context);
		await storage.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
