import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openRuntime } from "../src/node.ts";
import { PiWorkspace, WorkspaceShutdownFailed } from "../src/pi-workspace.ts";
import { deterministicModels } from "../src/testing.ts";

// This process intentionally retains an uncertain writer. Only process exit releases its real SQLite locks.
const directory = process.argv[2];
if (!directory) throw new Error("An isolated test directory is required");
const models = deterministicModels();
let failing = false;
let reserves = 0;
const runtime = await openRuntime(directory, {
	models,
	model: { provider: "faux", modelId: "faux-1" },
	catalogFailpoint: async (point) => {
		if (!failing) return;
		if (point === "after_reserve") reserves++;
		if (point === "before_ready") throw new Error("Injected registration failure");
	},
});
await runtime.call("createWorkspace", { workspaceId: "healthy", name: "Healthy" });
const original = PiWorkspace.open;
let opens = 0;
PiWorkspace.open = async (...args: Parameters<typeof PiWorkspace.open>) => {
	opens++;
	const workspace = await original(...args);
	workspace.close = async () => {
		throw new Error("Injected writer shutdown failure");
	};
	return workspace;
};
failing = true;
await assert.rejects(
	runtime.call("createWorkspace", { workspaceId: "uncertain", name: "Uncertain" }),
	WorkspaceShutdownFailed,
);
assert.equal(opens, 1);
assert.equal(reserves, 1);
await assert.rejects(runtime.call("createWorkspace", { workspaceId: "blocked", name: "Blocked" }), {
	code: "WORKSPACE_BUSY",
});
assert.equal(opens, 1, "unsafe admission must not open another PI writer");
assert.equal(reserves, 1, "unsafe admission must reject before catalog reservation");
await assert.rejects(stat(join(directory, "blocked")), { code: "ENOENT" });
assert.deepEqual(await runtime.call("getWorkspace", { workspaceId: "healthy" }), {
	workspaceId: "healthy",
	name: "Healthy",
});
assert.deepEqual((await runtime.call("listWorkspaces", {})).items, [{ workspaceId: "healthy", name: "Healthy" }]);
await assert.rejects(runtime.close(), { code: "WORKSPACE_BUSY" });
await assert.rejects(openRuntime(directory, { models }), { code: "WORKSPACE_BUSY" });
process.stdout.write("unsafe-owner-remains-locked\n");
process.exit(0);
