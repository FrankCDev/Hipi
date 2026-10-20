import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LIMITS } from "@hipi/work-runtime/contracts";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { fixture } from "./gui-flow.mjs";
import { historyAnswer, historyFixture, seedLongHistory, verifyColdHistory } from "./gui-long-history-fixture.mjs";

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

test(
	"source fixture durably seeds 200 messages; cold verifier detects source-mode probe duplication",
	{ timeout: 30000 },
	async () => {
		const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), "Hipi GUI profile-")));
		let runtime;
		let closed = true;
		let assertions = 0;
		const assertAllOwnedProcessesExited = () => {
			assertions++;
			assert.ok(closed);
		};
		try {
			const seed = await seedLongHistory({ ownedProfileRoot: root, assertAllOwnedProcessesExited });
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
