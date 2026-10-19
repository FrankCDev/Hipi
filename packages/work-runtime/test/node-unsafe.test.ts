import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRuntime } from "../src/node.ts";
import { deterministicModels } from "../src/testing.ts";

const run = promisify(execFile);
test(
	"uncertain startup shutdown blocks new writers before reservation and retains the root owner",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-node-unsafe-"));
		try {
			const result = await run(
				process.execPath,
				["--conditions=source", fileURLToPath(new URL("./node-unsafe-child.ts", import.meta.url)), directory],
				{ timeout: 10000 },
			);
			assert.match(result.stdout, /unsafe-owner-remains-locked/);
			// No lock removal or private state reset: successful reopening relies on the child's OS-level exit.
			const runtime = await openRuntime(directory, { models: deterministicModels() });
			try {
				assert.equal((await runtime.call("getWorkspace", { workspaceId: "healthy" })).name, "Healthy");
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
