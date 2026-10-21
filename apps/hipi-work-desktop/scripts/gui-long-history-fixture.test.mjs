import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { LIMITS } from "@hipi/work-runtime/contracts";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { smokeProfile } from "../src/launch/profile.ts";
import { fixture } from "./gui-flow.mjs";
import {
	fixtureProgress,
	historyAnswer,
	historyFixture,
	ownedHistoryDirectory,
	seedLongHistory,
	verifyColdHistory,
} from "./gui-long-history-fixture.mjs";
import { createGuiProfile } from "./smoke-packaged-gui.mjs";

test("fixture timing reports monotonic intervals and bounded numeric counts only", () => {
	let now = 10;
	const samples = [];
	const progress = fixtureProgress(
		(sample) => samples.push(sample),
		() => now,
	);
	progress("seed-start");
	now = 35;
	progress("seed-messages", 20);
	now = 47;
	progress("seed-shutdown");
	assert.deepEqual(samples, [
		{ stage: "seed-start", count: 0, elapsedMs: 0, intervalMs: 0 },
		{ stage: "seed-messages", count: 20, elapsedMs: 25, intervalMs: 25 },
		{ stage: "seed-shutdown", count: 0, elapsedMs: 37, intervalMs: 12 },
	]);
});

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
	async (t) => {
		const samples = [];
		const reportProgress = (sample) => {
			samples.push(sample);
			t.diagnostic(JSON.stringify(sample));
		};
		const progress = fixtureProgress(reportProgress);
		progress("source-test-start");
		const root = await createGuiProfile();
		let runtime;
		let closed = true;
		let assertions = 0;
		const assertAllOwnedProcessesExited = () => {
			assertions++;
			assert.ok(closed);
		};
		try {
			const seed = await seedLongHistory({ ownedProfileRoot: root, assertAllOwnedProcessesExited, reportProgress });
			progress("source-seed-returned", seed.persistedMessages);
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
			progress("source-probe-open");
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
			progress("source-probe-complete");
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
			progress("source-probe-shutdown");
			const result = await verifyColdHistory({
				ownedProfileRoot: root,
				seed,
				gui,
				assertAllOwnedProcessesExited,
				reportProgress,
			});
			progress("source-cold-verifier-returned", result.persistedMessages);
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
					reportProgress,
				}),
			);
			closed = false;
			runtime = await openTestRuntime(join(root, "profile/deterministic-store"), { tokensPerSecond: 100000 });
			await submit("duplicate-probe");
			progress("source-duplicate-probe-complete");
			await runtime.close();
			runtime = undefined;
			closed = true;
			await assert.rejects(
				verifyColdHistory({ ownedProfileRoot: root, seed, gui, assertAllOwnedProcessesExited, reportProgress }),
			);
			assert.ok((await readdir(root)).includes("profile"), "Verifier never deletes caller profile");
			assert.deepEqual(
				samples.filter(({ stage }) => stage === "seed-messages").map(({ count }) => count),
				Array.from({ length: 10 }, (_, i) => (i + 1) * 20),
			);
			for (const sample of samples) {
				assert.deepEqual(Object.keys(sample), ["stage", "count", "elapsedMs", "intervalMs"]);
				assert.match(sample.stage, /^[a-z-]+$/);
				for (const key of ["count", "elapsedMs", "intervalMs"])
					assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
			}
		} finally {
			await runtime?.close();
			await rm(root, { recursive: true, force: true });
			progress("source-test-cleaned");
		}
	},
);
