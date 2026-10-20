import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runBetweenGuiSessions } from "./gui-between-runs.mjs";
import { fixture } from "./gui-flow.mjs";
import { assertMaintenanceProjects, assertMaintenanceReopen, maintainElectronStore } from "./gui-maintenance.mjs";

test("maintenance archive requires exactly the original and empty ready projects with distinct identities", () => {
	const projects = {
		items: [
			{ name: fixture.workspace, workspaceId: "a", registration: "ready" },
			{ name: "GUI disclosure empty project", workspaceId: "b", registration: "ready" },
		],
		nextCursor: null,
	};
	assert.equal(assertMaintenanceProjects(projects, "a"), "b");
	for (const changed of [
		{ ...projects, items: projects.items.slice(0, 1) },
		{ ...projects, items: [...projects.items, projects.items[0]] },
		{ ...projects, nextCursor: "more" },
		{ ...projects, items: [projects.items[0], { ...projects.items[1], workspaceId: "a" }] },
		{ ...projects, items: [projects.items[0], { ...projects.items[1], name: "unexpected" }] },
		{ ...projects, items: [projects.items[0], { ...projects.items[1], registration: "reserved" }] },
	])
		assert.throws(() => assertMaintenanceProjects(changed, "a"));
	assert.throws(() => assertMaintenanceProjects(projects, "different-original"));
});

test("between-runs callback waits for exit and rechecks closure before releasing owned profile", async () => {
	const calls = [];
	const lifecycle = { resourcesClosed: true };
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const context = {
		assertAllOwnedProcessesExited: async () => {
			calls.push("closed");
		},
	};
	const running = runBetweenGuiSessions(
		async (received) => {
			assert.equal(received, context);
			calls.push("callback");
			await pending;
			return { passed: true };
		},
		context,
		lifecycle,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(lifecycle.resourcesClosed, false, "Pending callback must retain the profile");
	assert.deepEqual(calls, ["closed", "callback"]);
	release();
	assert.deepEqual(await running, { passed: true });
	assert.deepEqual(calls, ["closed", "callback", "closed"]);
	assert.equal(lifecycle.resourcesClosed, true);
});

test("precheck, callback and postcheck failures each retain owned directories and propagate failure", async () => {
	for (const failure of ["before", "callback", "after"]) {
		const lifecycle = { resourcesClosed: true };
		let observations = 0;
		let callbacks = 0;
		await assert.rejects(
			runBetweenGuiSessions(
				async () => {
					callbacks++;
					if (failure === "callback") throw new Error("callback closure uncertain");
				},
				{
					assertAllOwnedProcessesExited: async () => {
						observations++;
						if ((failure === "before" && observations === 1) || (failure === "after" && observations === 2))
							throw new Error("process closure uncertain");
					},
				},
				lifecycle,
			),
			/closure uncertain/,
		);
		assert.equal(lifecycle.resourcesClosed, false);
		assert.equal(callbacks, failure === "before" ? 0 : 1);
	}
});

test("actual GUI harness wires opt-in hook only after clean close and retains uncertain callback resources", async () => {
	const source = await readFile(new URL("./smoke-packaged-gui.mjs", import.meta.url), "utf8");
	const hook = source.indexOf("if (iteration === 0 && betweenRuns)");
	assert.ok(hook > source.indexOf('assert.equal(exit.code, 0, "Application shutdown was not clean")'));
	assert.ok(
		hook > source.indexOf("await assertNoPackageProcesses(appDirectory);", source.indexOf("browser.requestQuit()")),
	);
	assert.match(source, /safeCleanup = scenarioResourcesClosed && betweenRunsLifecycle\.resourcesClosed/);
	assert.match(source, /if \(safeCleanup\) \{\s*await rm\(owned/);
	assert.match(source, /else if \(scenario === "baseline"\) \{\s*assert\.deepEqual\(flow\.messageKeys, messageKeys/);
	assert.match(source, /const reportScenario = betweenRuns \? "maintenance" : scenario/);
	assert.match(source, /reportScenario === "baseline" \? "gui-smoke" : `gui-\$\{reportScenario\}`/);
});

test("maintenance refuses all filesystem/process work until the real GUI process exit observation succeeds", async () => {
	await assert.rejects(
		maintainElectronStore({
			ownedProfileRoot: "/must-not-be-read",
			assertAllOwnedProcessesExited: async () => {
				throw new Error("GUI is still alive");
			},
		}),
		/GUI is still alive/,
	);
});

test("interoperability acceptance requires same completed receipt and message IDs on actual reopen", () => {
	const first = {
		completedReceipt: {
			execution: "done",
			requestId: "original-submit",
			scope: { workspaceId: "work", conversationId: "one" },
		},
		messageKeys: ["message:1", "message:2"],
	};
	const reopened = { ...structuredClone(first), reopened: true };
	assertMaintenanceReopen({ first, reopened });
	for (const changed of [
		{ ...reopened, reopened: false },
		{ ...reopened, messageKeys: ["message:1", "message:3"] },
		{ ...reopened, completedReceipt: { ...first.completedReceipt, execution: "running" } },
		{ ...reopened, completedReceipt: { ...first.completedReceipt, requestId: "different-submit" } },
		{
			...reopened,
			completedReceipt: { ...first.completedReceipt, scope: { workspaceId: "work", conversationId: "other" } },
		},
	])
		assert.throws(() => assertMaintenanceReopen({ first, reopened: changed }));
});
