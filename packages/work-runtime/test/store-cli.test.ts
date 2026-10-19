import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseStoreCommand } from "../src/maintenance/cli-options.ts";
import { openTestRuntime } from "../src/testing.ts";

const cli = fileURLToPath(new URL("../src/store-cli.ts", import.meta.url));
function run(args: string[]) {
	return spawnSync(process.execPath, ["--conditions=source", cli, ...args], {
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 1024 * 1024,
	});
}

test("maintenance arguments preserve chosen paths and reject ambiguity before opening a store", () => {
	assert.deepEqual(parseStoreCommand([]), { command: "help" });
	assert.deepEqual(parseStoreCommand(["--help"]), { command: "help" });
	assert.deepEqual(parseStoreCommand(["backup", "--source", "原 工作库", "--destination", "新 备份"]), {
		command: "backup",
		source: "原 工作库",
		destination: "新 备份",
	});
	for (const args of [
		["backup", "--source", "a"],
		["backup", "--source", "a", "--source", "b", "--destination", "c"],
		["verify", "--backup", "a", "--destination", "ignored"],
		["restore", "--backup", "a", "--destination", "b", "extra"],
		["restore", "--backup", "a", "--destination", ""],
		["inspect", "--archive", "a\0b"],
		["unknown"],
		["activities", "--archive", "a", "--workspace", "w"],
		["activity-text", "--archive", "a", "--workspace", "w", "--conversation", "c"],
		["--help", "--source", "a"],
	])
		assert.throws(() => parseStoreCommand(args));
	const text = ["text", "--archive", "a", "--workspace", "w", "--conversation", "c", "--message", "1_0"];
	for (const offset of ["-1", "1.5", "01", "1e3", "9007199254740992"])
		assert.throws(() => parseStoreCommand([...text, "--offset", offset]));
	assert.deepEqual(parseStoreCommand([...text, "--offset", "0"]), {
		command: "text",
		archive: "a",
		workspace: "w",
		conversation: "c",
		message: "1_0",
		offset: 0,
	});
});

test("CLI reports invalid arguments without echoing private values or creating output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-store-cli-invalid-"));
	try {
		const result = run([
			"backup",
			"--source",
			"PRIVATE_SENTINEL",
			"--destination",
			join(directory, "unused"),
			"--unrecognized",
			"SECRET_SENTINEL",
		]);
		assert.equal(result.error, undefined);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Invalid arguments/);
		assert.doesNotMatch(result.stderr, /PRIVATE_SENTINEL|SECRET_SENTINEL/);
		assert.deepEqual(await readdir(directory), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("CLI backs up a closed real store, restores an isolated archive and exports persisted history", async () => {
	// Pass canonical fixture paths, as a user must when tmpdir has symlink ancestors on macOS.
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hipi-store-cli-")));
	const source = join(directory, "原 工作库");
	const backup = join(directory, "新 备份");
	const archive = join(directory, "历史 档案");
	const output = join(directory, "历史.ndjson");
	const runtime = await openTestRuntime(source, { tokensPerSecond: 100000 });
	try {
		await runtime.call("createWorkspace", { workspaceId: "work", name: "CLI work" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "Saved history",
		});
		await runtime.call("submit", {
			workspaceId: "work",
			conversationId: conversation.conversationId,
			requestId: "submit",
			text: "Fixture history 原文",
		});
		const deadline = Date.now() + 10000;
		while ((await runtime.call("getReceipt", { workspaceId: "work", requestId: "submit" }))?.execution !== "done") {
			assert.ok(Date.now() < deadline, "deterministic fixture did not finish");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await runtime.close();
		for (const args of [
			["backup", "--source", source, "--destination", backup],
			["verify", "--backup", backup],
			["restore", "--backup", backup, "--destination", archive],
			["inspect", "--archive", archive],
			["workspaces", "--archive", archive],
			["conversations", "--archive", archive, "--workspace", "work"],
			["history", "--archive", archive, "--workspace", "work", "--conversation", conversation.conversationId],
			["activities", "--archive", archive, "--workspace", "work", "--conversation", conversation.conversationId],
			[
				"export-history",
				"--archive",
				archive,
				"--workspace",
				"work",
				"--conversation",
				conversation.conversationId,
				"--output",
				output,
			],
		]) {
			const result = run(args);
			assert.equal(result.error, undefined);
			assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
			const value = JSON.parse(result.stdout);
			assert.equal(value.ok, true);
			if (args[0] === "inspect") {
				assert.equal(value.result.readOnly, true);
				assert.equal(value.result.mode, "recovery_archive");
			}
			if (args[0] === "history") assert.match(JSON.stringify(value.result), /Fixture history 原文/);
		}
		const exported = await readFile(output, "utf8");
		assert.match(exported, /Historical snapshot only/);
		assert.match(exported, /Fixture history 原文/);
		const existing = run(["restore", "--backup", backup, "--destination", archive]);
		assert.equal(existing.status, 1);
		assert.equal(JSON.parse(existing.stderr).error.code, "TARGET_EXISTS");
		assert.equal(await readFile(output, "utf8"), exported);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
