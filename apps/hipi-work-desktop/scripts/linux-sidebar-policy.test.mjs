import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSidebarPolicy, sidebarPolicyAllowed, sidebarPolicyMarker } from "./linux-sidebar-policy.mjs";

const env = {
	HIPI_SIDEBAR_POLICY_ONCE: sidebarPolicyMarker,
	GITHUB_ACTIONS: "true",
	GITHUB_EVENT_NAME: "push",
	GITHUB_REPOSITORY: "FrankCDev/Hipi",
	GITHUB_REF: "refs/heads/dot/develop",
	GITHUB_WORKFLOW_REF: "FrankCDev/Hipi/.github/workflows/hipi-work-ci.yml@refs/heads/dot/develop",
	GITHUB_RUN_NUMBER: "34",
	GITHUB_RUN_ATTEMPT: "1",
	HIPI_CI_MATRIX_OS: "ubuntu-24.04",
	RUNNER_OS: "Linux",
	GITHUB_SHA: "a".repeat(40),
	GITHUB_EVENT_PATH: "/event.json",
};
const owned = "/tmp/Hipi GUI 中文 验证-Ab1234";
const binary = `${owned}/真实 应用/hipi-work`;
function fixture(options = {}) {
	const calls = [];
	let loaded = false;
	let profileName;
	const io = {
		uid: () => 1001,
		realpath: async (path) => path,
		lstat: async (path) => ({
			uid: 1001,
			mode: 0o755,
			isSymbolicLink: () => false,
			isDirectory: () => path !== binary,
			isFile: () => path === binary,
		}),
		readFile: async (path) => {
			if (path === "/event.json")
				return JSON.stringify({
					after: env.GITHUB_SHA,
					head_commit: { id: env.GITHUB_SHA, message: `fix: sidebar\n\n${sidebarPolicyMarker}` },
				});
			if (path === "/etc/os-release") return 'ID=ubuntu\nVERSION_ID="24.04"\n';
			if (path === "/proc/123/attr/current") return `${profileName} (unconfined)\n`;
			return path.endsWith("enabled") ? "Y\n" : "1\n";
		},
		run: (args, input) => {
			calls.push({ args, input });
			if (args[0] === "/usr/bin/ps") return options.liveLabel ? `${profileName}//&other` : "unconfined\n";
			if (args[0] === "/usr/bin/cat") return loaded ? `${profileName} (unconfined)\n` : "unrelated (enforce)\n";
			assert.equal(args[0], "/sbin/apparmor_parser");
			profileName = input.match(/profile ([^ ]+) /)[1];
			if (args.includes("--add")) {
				if (options.addFailure) throw new Error("add outcome unknown");
				loaded = true;
			} else {
				assert.ok(args.includes("--remove"));
				if (options.removeFailure) throw new Error("remove outcome unknown");
				loaded = false;
			}
			return "";
		},
	};
	return {
		io,
		calls,
		policy: () => createSidebarPolicy({ owned, binary, scenario: "sidebar", env, platform: "linux" }, io),
	};
}

test("one-shot denies other runs, reruns, events, repositories, workflows, hosts and scenarios without privileged reads or writes", async () => {
	for (const [key, value] of Object.entries({
		HIPI_SIDEBAR_POLICY_ONCE: "",
		GITHUB_ACTIONS: "false",
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_REPOSITORY: "fork/Hipi",
		GITHUB_REF: "refs/heads/main",
		GITHUB_WORKFLOW_REF: "other",
		GITHUB_RUN_NUMBER: "35",
		GITHUB_RUN_ATTEMPT: "2",
		HIPI_CI_MATRIX_OS: "ubuntu-22.04",
		RUNNER_OS: "Windows",
		GITHUB_SHA: "invalid",
	})) {
		const f = fixture();
		const policy = createSidebarPolicy(
			{ owned, binary, scenario: "sidebar", env: { ...env, [key]: value }, platform: "linux" },
			f.io,
		);
		assert.equal(policy.evidence.eligible, false, key);
		await policy.setup();
		await policy.assertAttached(123, 0);
		await policy.cleanup(() => assert.fail("Unexpected cleanup"));
		assert.deepEqual(f.calls, []);
	}
	for (const scenario of ["baseline", "long-history", "file-workbench", "maintenance"])
		assert.equal(sidebarPolicyAllowed(env, scenario, "linux"), false);
	assert.equal(sidebarPolicyAllowed(env, "sidebar", "darwin"), false);
});

test("literal exact-path ABI4 allowance remains for cold restart, verifies attachment and removes after shutdown", async () => {
	const f = fixture();
	const p = f.policy();
	await p.setup();
	const add = f.calls.find((call) => call.args.includes("--add"));
	assert.equal(
		add.input,
		`abi <abi/4.0>,\nprofile ${p.evidence.profileName} "${binary}" flags=(unconfined) {\n  userns,\n}\n`,
	);
	assert.deepEqual(add.args, ["/sbin/apparmor_parser", "--add", "--skip-cache", "--config-file=/dev/null"]);
	await p.assertAttached(123, 0);
	await p.assertAttached(123, 1);
	assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, 0);
	await p.cleanup(async () => f.calls.push({ args: ["stopped"] }));
	assert.ok(
		f.calls.findIndex((call) => call.args[0] === "stopped") <
			f.calls.findIndex((call) => call.args.includes("--remove")),
	);
	assert.equal(p.evidence.attachments.length, 2);
	assert.equal(p.evidence.globalSettingsUnchanged, true);
	assert.equal(p.evidence.cleanup, "removed_after_owned_process_shutdown");
	await p.cleanup(() => assert.fail("Cleanup must be idempotent"));
	assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, 1);
});

test("invalid marker, OS, ownership, symlink, permissions and canonical path reject before privileged actions", async () => {
	const changes = [
		(io) => {
			const read = io.readFile;
			io.readFile = (p) =>
				p === "/event.json"
					? JSON.stringify({
							after: env.GITHUB_SHA,
							head_commit: { id: env.GITHUB_SHA, message: `prefix${sidebarPolicyMarker}` },
						})
					: read(p);
		},
		(io) => {
			const read = io.readFile;
			io.readFile = (p) => (p === "/etc/os-release" ? 'ID=ubuntu\nVERSION_ID="22.04"' : read(p));
		},
		(io) => {
			io.realpath = async (p) => `${p}-elsewhere`;
		},
		(io) => {
			io.uid = () => 0;
		},
		...[{ uid: 2 }, { mode: 0o777 }, { mode: 0o4755 }, { isSymbolicLink: () => true }].map((change) => (io) => {
			const stat = io.lstat;
			io.lstat = async (p) => ({ ...(await stat(p)), ...change });
		}),
	];
	for (const change of changes) {
		const f = fixture();
		change(f.io);
		await assert.rejects(f.policy().setup());
		assert.deepEqual(f.calls, []);
	}
	for (const bad of [
		"/tmp/other",
		`${owned}*`,
		`${owned}\\`,
		`${owned}"`,
		`${owned}\n`,
		`${owned}{a,b}`,
		`${owned}@{HOME}`,
	]) {
		const f = fixture();
		const p = createSidebarPolicy(
			{ owned: bad, binary: `${bad}/真实 应用/hipi-work`, scenario: "sidebar", env, platform: "linux" },
			f.io,
		);
		await assert.rejects(p.setup());
		assert.deepEqual(f.calls, []);
	}
});

test("existing profile collision never loads or unloads", async () => {
	const f = fixture();
	const original = f.io.run;
	f.io.run = (args, input) => (args[0] === "/usr/bin/cat" ? `${f.policyName} (unconfined)` : original(args, input));
	// Discover deterministic name from a separate mocked successful lifecycle.
	const other = fixture();
	const probe = other.policy();
	await probe.setup();
	f.policyName = probe.evidence.profileName;
	const p = f.policy();
	await assert.rejects(p.setup(), /collision/);
	await p.cleanup(() => assert.fail());
	assert.deepEqual(f.calls, []);
});

test("failed load preserves uncertainty and never removes an unowned policy", async () => {
	const f = fixture({ addFailure: true });
	const p = f.policy();
	await assert.rejects(p.setup(), /unknown/);
	await assert.rejects(
		p.cleanup(() => assert.fail()),
		/uncertain/,
	);
	assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, 0);
});

test("launch failure cleanup works but live process and uncertain removal fail closed", async () => {
	for (const kind of ["shutdown", "liveLabel", "removeFailure"]) {
		const f = fixture({ [kind]: true });
		const p = f.policy();
		await p.setup();
		await assert.rejects(
			p.cleanup(async () => {
				if (kind === "shutdown") throw new Error("still alive");
			}),
		);
		assert.notEqual(p.evidence.cleanup, "removed_after_owned_process_shutdown");
		assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, kind === "removeFailure" ? 1 : 0);
	}
});

test("mismatched profile attachment and global changes are not accepted as sandbox proof", async () => {
	const f = fixture();
	const p = f.policy();
	await p.setup();
	const read = f.io.readFile;
	f.io.readFile = (path) => (path.includes("/attr/") ? "unconfined" : read(path));
	await assert.rejects(p.assertAttached(123, 0), /did not attach/);
	f.io.readFile = (path) => (path.endsWith("userns_clone") ? "0" : read(path));
	await assert.rejects(
		p.cleanup(async () => {}),
		/Global sandbox settings changed/,
	);
	assert.notEqual(p.evidence.globalSettingsUnchanged, true);
});

test("source keeps one-shot env only on sidebar step and removes policy in finally before directory deletion", async () => {
	const workflow = await readFile(new URL("../../../.github/workflows/hipi-work-ci.yml", import.meta.url), "utf8");
	assert.equal(workflow.split("HIPI_SIDEBAR_POLICY_ONCE:").length, 2);
	assert.ok(workflow.indexOf("id: sidebar") < workflow.indexOf("HIPI_SIDEBAR_POLICY_ONCE:"));
	assert.match(workflow, /github\.run_number == 34 && github\.run_attempt == 1/);
	const harness = await readFile(new URL("./smoke-packaged-gui.mjs", import.meta.url), "utf8");
	assert.ok(harness.indexOf("await sidebarPolicy.setup()") < harness.indexOf("native = startProcess("));
	assert.ok(harness.indexOf("} finally {") < harness.indexOf("await sidebarPolicy?.cleanup"));
	assert.ok(harness.indexOf("await sidebarPolicy?.cleanup") < harness.indexOf("await rm(owned"));
});

test("post-add and post-remove visibility failures keep ownership evidence and fail closed", async () => {
	for (const phase of ["afterAdd", "afterRemove"]) {
		const f = fixture();
		const original = f.io.run;
		let added = false;
		let removed = false;
		let name;
		f.io.run = (args, input) => {
			const result = original(args, input);
			if (args.includes("--add")) {
				added = true;
				name = input.match(/profile ([^ ]+) /)[1];
			}
			if (args.includes("--remove")) removed = true;
			if (args[0] === "/usr/bin/cat") {
				if (phase === "afterAdd" && added && !removed) return "";
				if (phase === "afterRemove" && removed) return `${name} (unconfined)`;
			}
			return result;
		};
		const p = f.policy();
		if (phase === "afterAdd") {
			await assert.rejects(p.setup(), /not visible/);
			await p.cleanup(async () => {});
			assert.equal(p.evidence.cleanup, "removed_after_owned_process_shutdown");
		} else {
			await p.setup();
			await assert.rejects(
				p.cleanup(async () => {}),
				/remains loaded/,
			);
			assert.equal(p.evidence.cleanup, "removal_pending");
		}
		assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, 1);
	}
});

test("missing or truncated process labels cannot authorize policy removal", async () => {
	for (const labels of ["", "\n", "-\n", "?\n", "unconfined\n?\n"]) {
		const f = fixture();
		const original = f.io.run;
		f.io.run = (args, input) => (args[0] === "/usr/bin/ps" ? labels : original(args, input));
		const p = f.policy();
		await p.setup();
		await assert.rejects(
			p.cleanup(async () => {}),
			/labels unavailable/,
		);
		assert.equal(f.calls.filter((call) => call.args.includes("--remove")).length, 0);
	}
});

test("push payload must bind both commit identities to the exact workflow SHA", async () => {
	for (const mismatch of ["after", "head"]) {
		const f = fixture();
		const original = f.io.readFile;
		f.io.readFile = async (path) => {
			const value = await original(path);
			if (path !== "/event.json") return value;
			const event = JSON.parse(value);
			if (mismatch === "after") event.after = "b".repeat(40);
			else event.head_commit.id = "b".repeat(40);
			return JSON.stringify(event);
		};
		await assert.rejects(f.policy().setup(), /SHA mismatch/);
		assert.deepEqual(f.calls, []);
	}
});

test("failed post-load visibility query still cleans only the successfully owned policy", async () => {
	const f = fixture();
	const original = f.io.run;
	let queries = 0;
	f.io.run = (args, input) => {
		if (args[0] === "/usr/bin/cat" && ++queries === 2) throw new Error("query failed");
		return original(args, input);
	};
	const p = f.policy();
	await assert.rejects(p.setup(), /query failed/);
	await p.cleanup(async () => {});
	assert.equal(p.evidence.cleanup, "removed_after_owned_process_shutdown");
});
