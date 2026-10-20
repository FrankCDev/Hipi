import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { LIMITS } from "@hipi/work-runtime/contracts";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { smokeProfile } from "../src/smoke-profile.ts";
import { fixture } from "./gui-flow.mjs";
import {
	historyAnswer,
	historyFixture,
	ownedHistoryDirectory,
	seedLongHistory,
	verifyColdHistory,
} from "./gui-long-history-fixture.mjs";
import { createGuiProfile } from "./smoke-packaged-gui.mjs";

test("fixture contains actual multiline Markdown and one bounded original beyond preview", () => {
	assert.match(historyAnswer(0), /\n\n\| Item \| Value \|\n/);
	assert.match(historyAnswer(0), /\n```typescript\n/);
	assert.ok(historyAnswer(0).length < LIMITS.messagePreview);
	const original = historyAnswer(historyFixture.expansionTurn);
	assert.ok(original.length > LIMITS.messagePreview && original.length < LIMITS.textChunk);
	assert.ok(!original.slice(0, LIMITS.messagePreview).includes("ORIGINAL_END_001"));
	assert.ok(original.endsWith("ORIGINAL_END_001"));
});

test("fixture operations require exited-process assertion before inspecting or creating a profile", async () => {
	for (const operation of [seedLongHistory, verifyColdHistory]) {
		await assert.rejects(
			operation({
				ownedProfileRoot: "/must-not-be-read",
				assertAllOwnedProcessesExited() {
					throw new Error("Owned process still running");
				},
			}),
			/Owned process still running/,
		);
	}
});

test("history fixture rejects linked roots/children, non-directory children and profiles outside direct temporary parent", async () => {
	const root = await createGuiProfile();
	const target = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "history-fixture-target-")));
	try {
		const nested = realpathSync(await mkdtemp(join(target, "Hipi GUI profile-")));
		await assert.rejects(ownedHistoryDirectory(nested));
		assert.deepEqual(await readdir(nested), []);
		const alias = join(root, "Hipi GUI profile-Linked");
		await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(ownedHistoryDirectory(alias), /Profile root must be canonical/);
		await rm(alias);
		await symlink(target, join(root, "profile"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(ownedHistoryDirectory(root), /Fixture store escaped owned profile/);
		await rm(join(root, "profile"));
		await mkdir(join(root, "profile"), { mode: 0o700 });
		const store = join(root, "profile/deterministic-store");
		await symlink(target, store, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(ownedHistoryDirectory(root), /Fixture store escaped owned profile/);
		await rm(store);
		await writeFile(store, "not a directory");
		await assert.rejects(ownedHistoryDirectory(root));
		assert.deepEqual(await readdir(target), [basename(nested)], "No store writes may follow linked ancestors");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test(
	"Windows owned case alias uses the same canonicalizer as native startup, not native realpath spelling",
	{
		skip: process.platform !== "win32",
	},
	async () => {
		const root = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "Hipi GUI profile-Case")));
		const alias = join(dirname(root), basename(root).replace("profile-Case", "profile-cASE"));
		try {
			assert.notEqual(alias, root);
			assert.equal(realpathSync(alias), alias);
			assert.equal(await realpath(alias), await realpath(root), "Both spellings must identify the owned directory");
			assert.notEqual(await realpath(alias), alias, "Exercise the native/synchronous spelling disagreement");
			const directory = await ownedHistoryDirectory(alias);
			assert.equal(directory, join(alias, "profile/deterministic-store"));
			assert.equal(smokeProfile([`--smoke-data-root=${alias}`], "deterministic").userData, join(alias, "profile"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"source fixture durably seeds 200 messages; cold verifier detects source-mode probe duplication",
	{ timeout: 30000 },
	async () => {
		const root = await createGuiProfile();
		let runtime;
		let closed = true;
		let assertions = 0;
		const assertAllOwnedProcessesExited = () => {
			assertions++;
			assert.ok(closed);
		};
		try {
			const seed = await seedLongHistory({ ownedProfileRoot: root, assertAllOwnedProcessesExited });
			assert.equal(smokeProfile([`--smoke-data-root=${root}`], "deterministic").userData, join(root, "profile"));
			assert.equal(seed.persistedMessages, 200);
			assert.equal(seed.long.messages.length, 200);
			assert.equal(seed.coldReadPages, 7);
			assert.ok(!JSON.stringify(seed).includes(root), "Public report cannot carry directory authority");
			await assert.rejects(
				seedLongHistory({ ownedProfileRoot: root, assertAllOwnedProcessesExited }),
				/nonempty store/,
			);
			closed = false;
			runtime = await openTestRuntime(join(root, "profile/deterministic-store"), { tokensPerSecond: 100000 });
			// This is a verifier unit/integration probe, deliberately NOT evidence of GUI submission.
			const requestId = "source-verifier-probe";
			const submit = async (id) => {
				await runtime.call("submit", {
					workspaceId: seed.workspaceId,
					conversationId: seed.long.conversationId,
					requestId: id,
					text: seed.probe,
				});
				const deadline = Date.now() + 10000;
				while (
					(await runtime.call("getReceipt", { workspaceId: seed.workspaceId, requestId: id }))?.execution !== "done"
				) {
					assert.ok(Date.now() < deadline);
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			};
			await submit(requestId);
			const tail = await runtime.call("getHistory", {
				workspaceId: seed.workspaceId,
				conversationId: seed.long.conversationId,
			});
			const gui = {
				persistedProbe: {
					userKey: `message:${tail.messages.at(-2).id}`,
					answerKey: `message:${tail.messages.at(-1).id}`,
					answerText: fixture.answer,
					requestId,
				},
			};
			await runtime.close();
			runtime = undefined;
			closed = true;
			const result = await verifyColdHistory({ ownedProfileRoot: root, seed, gui, assertAllOwnedProcessesExited });
			assert.equal(result.originalSeedIdsAndTextPreserved, true);
			assert.equal(result.persistedMessages, 202);
			assert.equal(result.probeCount, 1);
			assert.equal(result.controlMessages, 2);
			assert.equal(smokeProfile([`--smoke-data-root=${root}`], "deterministic").userData, join(root, "profile"));
			assert.equal(assertions, 3);
			await assert.rejects(
				verifyColdHistory({
					ownedProfileRoot: root,
					seed,
					gui: { persistedProbe: { ...gui.persistedProbe, answerText: "wrong answer" } },
					assertAllOwnedProcessesExited,
				}),
			);
			closed = false;
			runtime = await openTestRuntime(join(root, "profile/deterministic-store"), { tokensPerSecond: 100000 });
			await submit("duplicate-probe");
			await runtime.close();
			runtime = undefined;
			closed = true;
			await assert.rejects(verifyColdHistory({ ownedProfileRoot: root, seed, gui, assertAllOwnedProcessesExited }));
			assert.ok((await readdir(root)).includes("profile"), "Verifier never deletes caller profile");
		} finally {
			await runtime?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
