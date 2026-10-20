import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import maintenance from "../packaging/linux-maintenance.cjs";
import { click, evaluate, exercise, fixture, receiptScope, until, waitForOverlayClosed } from "./gui-flow.mjs";
import { startProcess } from "./gui-process.mjs";
import { inventory, sha256 } from "./release-policy.mjs";
import { assertOriginalStoreUnchanged } from "./smoke-store-invariants.mjs";

export async function exerciseMaintenanceGui({ cdp, directory, reopened, fontObservations }) {
	// Retain every original baseline interaction and collect one extra actual UI
	// receipt observation, including after the second genuine Electron startup.
	const flow = await exercise(cdp, directory, reopened, fontObservations);
	await click(cdp, 'button[aria-label="Conversation details"]');
	await until(
		() =>
			evaluate(cdp, `document.querySelector('[data-testid="execution-status"]')?.textContent === 'Result confirmed'`),
		"original execution receipt remains completed",
	);
	const scope = await receiptScope(cdp);
	assert.deepEqual(scope, flow.toolPacks.scope);
	const requestId = await evaluate(cdp, "document.querySelector('[data-testid=\"request-id\"]')?.textContent");
	assert.match(requestId, /^[A-Za-z0-9_-]{1,128}$/, "Completed GUI receipt must have its original request ID");
	await click(cdp, ".workbench-detail-dialog button", "Close");
	await waitForOverlayClosed(cdp, 'button[aria-label="Conversation details"]');
	return { ...flow, completedReceipt: { scope, requestId, execution: "done" } };
}

export function assertMaintenanceReopen({ first, reopened }) {
	assert.equal(first.completedReceipt.execution, "done");
	assert.match(first.completedReceipt.requestId, /^[A-Za-z0-9_-]{1,128}$/);
	assert.deepEqual(reopened.completedReceipt, first.completedReceipt, "Electron reopen changed the original receipt");
	assert.deepEqual(reopened.messageKeys, first.messageKeys, "Electron reopen changed original message identities");
	assert.equal(reopened.reopened, true);
}

export async function maintainElectronStore({
	ownedProfileRoot,
	ownedApplicationRoot,
	ownedScratchRoot,
	firstFlow,
	releaseProvenance,
	assertAllOwnedProcessesExited,
}) {
	// This observer runs before any file access or child spawn. The caller also
	// rechecks after return; a thrown callback keeps its owned directories intact.
	await assertAllOwnedProcessesExited();
	maintenance.assertRuntimeTarget(process.platform, process.arch);
	const source = join(ownedProfileRoot, "profile/deterministic-store");
	assert.equal(await realpath(source), source, "Maintenance source escaped the owned Electron profile");
	const runtime = await maintenance.verifyLinuxMaintenancePackage(ownedApplicationRoot);
	assert.deepEqual(runtime, releaseProvenance.linuxHardening.maintenance);
	assert.deepEqual(runtime.runtime, releaseProvenance.linuxMaintenanceRuntime);
	const fuses = await maintenance.verifyLinuxFuses(join(ownedApplicationRoot, "hipi-work"));
	assert.deepEqual(fuses, releaseProvenance.linuxHardening.fuses);
	const before = await inventory(source);
	const backup = join(ownedScratchRoot, "maintenance backup");
	const archive = join(ownedScratchRoot, "maintenance history archive");
	const exportedFile = join(ownedScratchRoot, "maintenance history.ndjson");
	const commands = [];
	const execute = async (args) => {
		// A sibling of the already-stopped GUI, never a subprocess of that GUI.
		const child = startProcess(join(ownedApplicationRoot, "hipi-work-maintenance"), args, {
			cwd: ownedScratchRoot,
			env: { PATH: "/usr/bin:/bin", HOME: ownedScratchRoot, TMPDIR: ownedScratchRoot, LANG: "C.UTF-8" },
		});
		let stdout = "";
		child.child.stdout.on("data", (chunk) => {
			if (stdout.length + chunk.length <= 1024 * 1024) stdout += chunk.toString("utf8");
		});
		try {
			const exit = await child.wait();
			assert.equal(exit.code, 0, "Standalone maintenance command failed");
			assert.equal(exit.signal, null);
			assert.equal(child.overflow, false, "Standalone maintenance exceeded the output budget");
			const response = JSON.parse(stdout);
			assert.equal(response.ok, true);
			assert.equal(response.command, args[0]);
			commands.push(args[0]);
			return response.result;
		} finally {
			// The process owner never signals an already-closed/reused PID. An
			// unconfirmed termination throws and prevents harness profile cleanup.
			await child.terminate();
		}
	};
	const backedUp = await execute(["backup", "--source", source, "--destination", backup]);
	const verified = await execute(["verify", "--backup", backup]);
	assert.equal(verified.verified, true);
	assert.equal(verified.workspaceCount, 1);
	assert.equal(verified.manifestDigest, backedUp.manifestDigest);
	await execute(["restore", "--backup", backup, "--destination", archive]);
	const archiveBefore = await inventory(archive);
	const info = await execute(["inspect", "--archive", archive]);
	assert.equal(info.readOnly, true);
	assert.equal(info.mode, "recovery_archive");
	const { workspaceId, conversationId } = firstFlow.completedReceipt.scope;
	const scope = ["--archive", archive, "--workspace", workspaceId, "--conversation", conversationId];
	const history = await execute(["history", ...scope]);
	assert.deepEqual(
		history.messages.map((message) => `message:${message.id}`),
		firstFlow.messageKeys,
	);
	assert.ok(JSON.stringify(history).includes(fixture.text));
	assert.ok(JSON.stringify(history).includes(fixture.answer));
	const activities = await execute(["activities", ...scope]);
	assert.equal(activities.readOnly, true);
	assert.equal(activities.evidence, "snapshot_only");
	const exported = await execute(["export-history", ...scope, "--output", exportedFile]);
	const exportBytes = await readFile(exportedFile);
	const lines = exportBytes
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(lines[0].type, "snapshot");
	assert.equal(lines[0].readOnly, true);
	assert.match(lines[0].warning, /Historical snapshot only/);
	assert.equal(lines.at(-1).type, "complete");
	assert.equal(lines.at(-1).messages, exported.messages);
	assert.deepEqual(
		lines.filter((line) => line.type === "message").map((line) => `message:${line.id}`),
		firstFlow.messageKeys,
	);
	assert.ok(exportBytes.toString("utf8").includes(fixture.text));
	assert.ok(exportBytes.toString("utf8").includes(fixture.answer));
	assert.deepEqual(await inventory(archive), archiveBefore, "Reading changed the snapshot-only archive");
	const transientSidecars = assertOriginalStoreUnchanged(before, await inventory(source));
	await assertAllOwnedProcessesExited();
	return {
		status: "maintenance_passed_reopen_required",
		runtime,
		fuses,
		commands,
		originalFilesUnchanged: true,
		transientSidecars,
		archiveReadOnlyUnchanged: true,
		originalMessageKeys: firstFlow.messageKeys,
		exportSha256: sha256(exportBytes),
	};
}
