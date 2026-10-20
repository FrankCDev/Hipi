import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { profileEvidence, profileRootEvidence } from "./gui-profile-evidence.mjs";

test("profile diagnostics report only fixed metadata, never port contents or unknown files", async () => {
	const root = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "hipi-gui-profile-evidence-")));
	try {
		assert.deepEqual(await profileRootEvidence(root), {
			canonicalEqual: true,
			resolvedEqual: true,
			parentMatchesTemporary: true,
		});
		await mkdir(join(root, "session"));
		await writeFile(join(root, "session/DevToolsActivePort"), "secret-port-content");
		await writeFile(join(root, "unrelated-secret"), "private");
		const evidence = await profileEvidence(root);
		assert.equal(evidence.length, 9);
		const port = evidence.find((entry) => entry.path === "session/DevToolsActivePort");
		assert.equal(port.exists, true);
		assert.equal(port.type, "file");
		assert.equal(port.bytes, 19);
		assert.equal(port.canonicalEqual, true);
		assert.equal(evidence.find((entry) => entry.path === "profile/DevToolsActivePort").exists, false);
		const output = JSON.stringify(evidence);
		assert.ok(!output.includes("secret") && !output.includes(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fixed profile probes do not traverse a linked ancestor", async () => {
	const root = await mkdtemp(join(tmpdir(), "hipi-gui-profile-evidence-"));
	const outside = await mkdtemp(join(tmpdir(), "hipi-gui-profile-target-"));
	try {
		await writeFile(join(outside, "DevToolsActivePort"), "must-not-be-observed");
		await symlink(outside, join(root, "session"), process.platform === "win32" ? "junction" : "dir");
		const evidence = await profileEvidence(root);
		assert.equal(evidence.find((entry) => entry.path === "session").type, "symlink");
		assert.equal(evidence.find((entry) => entry.path === "session").canonicalEqual, false);
		assert.equal((await profileRootEvidence(join(root, "session"))).canonicalEqual, false);
		assert.deepEqual(
			evidence.find((entry) => entry.path === "session/DevToolsActivePort"),
			{ path: "session/DevToolsActivePort", exists: false, blockedAncestor: "session" },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
