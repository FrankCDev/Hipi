import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { smokeProfile } from "../src/smoke-profile.ts";
import { createGuiProfile, sourceProvenanceEvidence } from "./smoke-packaged-gui.mjs";

test("GUI-created profile passes the unchanged native startup boundary on first launch and reopen", async () => {
	const root = await createGuiProfile();
	try {
		assert.equal(root, realpathSync(root));
		assert.equal(dirname(root), realpathSync(tmpdir()));
		const args = [`--smoke-data-root=${root}`];
		const paths = smokeProfile(args, "deterministic");
		assert.equal(paths.userData, join(root, "profile"));
		assert.deepEqual(smokeProfile(args, "deterministic"), paths);
		await mkdir(join(root, "unexpected"));
		assert.throws(() => smokeProfile(args, "deterministic"), /Unexpected smoke profile contents/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("GUI evidence retains exact source path/hash manifest and rejects a mismatched checksum", () => {
	const sourceSnapshot = [{ file: "apps/hipi-work-ui/src/app.tsx", sha256: "a".repeat(64) }];
	const sourceSnapshotSha256 = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
	const report = sourceProvenanceEvidence({ sourceSnapshot, sourceSnapshotSha256, unrelatedMetadata: "not copied" });
	assert.deepEqual(report, { sourceSnapshot, sourceSnapshotSha256 });
	assert.notEqual(report.sourceSnapshot, sourceSnapshot);
	assert.notEqual(report.sourceSnapshot[0], sourceSnapshot[0]);
	assert.throws(() => sourceProvenanceEvidence({ sourceSnapshot, sourceSnapshotSha256: "b".repeat(64) }));
	const withExtra = [{ ...sourceSnapshot[0], environment: "must not enter source evidence" }];
	assert.throws(() =>
		sourceProvenanceEvidence({
			sourceSnapshot: withExtra,
			sourceSnapshotSha256: createHash("sha256").update(JSON.stringify(withExtra)).digest("hex"),
		}),
	);
});
