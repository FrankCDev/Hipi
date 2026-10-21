import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { posix } from "node:path";

// One approved CI attempt, not a reusable Linux launch workaround.
export const sidebarPolicyMarker = "[hipi-sidebar-policy-once-20261020-231348]";
const workflow = "FrankCDev/Hipi/.github/workflows/hipi-work-ci.yml@refs/heads/dot/develop";
const profilesPath = "/sys/kernel/security/apparmor/profiles";
const globalPaths = [
	"/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
	"/proc/sys/kernel/unprivileged_userns_clone",
	"/proc/sys/user/max_user_namespaces",
	"/sys/module/apparmor/parameters/enabled",
];
const production = {
	readFile,
	lstat,
	realpath,
	uid: () => process.getuid(),
	run: (args, input) =>
		execFileSync("/usr/bin/sudo", ["-n", ...args], {
			input,
			encoding: "utf8",
			timeout: 15000,
			maxBuffer: 1024 * 1024,
			env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
			stdio: ["pipe", "pipe", "pipe"],
		}),
};

export function sidebarPolicyAllowed(env, scenario, platform) {
	return (
		platform === "linux" &&
		scenario === "sidebar" &&
		env.HIPI_SIDEBAR_POLICY_ONCE === sidebarPolicyMarker &&
		env.GITHUB_ACTIONS === "true" &&
		env.GITHUB_EVENT_NAME === "push" &&
		env.GITHUB_REPOSITORY === "FrankCDev/Hipi" &&
		env.GITHUB_REF === "refs/heads/dot/develop" &&
		env.GITHUB_WORKFLOW_REF === workflow &&
		env.GITHUB_RUN_NUMBER === "34" &&
		env.GITHUB_RUN_ATTEMPT === "1" &&
		env.HIPI_CI_MATRIX_OS === "ubuntu-24.04" &&
		env.RUNNER_OS === "Linux" &&
		/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
	);
}

/** Construct before setup so finally owns cleanup even when setup or GUI launch fails. */
export function createSidebarPolicy(
	{ owned, binary, scenario, env = process.env, platform = process.platform },
	io = production,
) {
	const evidence = {
		eligible: sidebarPolicyAllowed(env, scenario, platform),
		purpose: "one-run Ubuntu24 sidebar compatibility fixture",
		productSandboxQualified: false,
		setup: "not_requested",
		attachments: [],
		cleanup: "not_needed",
	};
	let profile;
	let name;
	let loaded = false;
	let attempted = false;
	let baseline;
	async function globals() {
		return Object.fromEntries(
			await Promise.all(globalPaths.map(async (path) => [path, (await io.readFile(path, "utf8")).trim()])),
		);
	}
	function present() {
		return io
			.run(["/usr/bin/cat", profilesPath])
			.split("\n")
			.some((line) => line.startsWith(`${name} (`));
	}
	return {
		evidence,
		async setup() {
			if (!evidence.eligible) return;
			assert.equal(attempted, false, "Policy setup cannot be repeated");
			attempted = true;
			assert.notEqual(io.uid(), 0, "Policy fixture must be owned by a non-root runner");
			const event = JSON.parse(await io.readFile(env.GITHUB_EVENT_PATH, "utf8"));
			assert.equal(event.after, env.GITHUB_SHA, "Push event SHA mismatch");
			assert.equal(event.head_commit?.id, env.GITHUB_SHA, "Head commit SHA mismatch");
			assert.ok(
				event.head_commit.message.split(/\r?\n/).includes(sidebarPolicyMarker),
				"Missing exact head commit marker line",
			);
			const os = await io.readFile("/etc/os-release", "utf8");
			assert.match(os, /^ID=ubuntu$/m);
			assert.match(os, /^VERSION_ID="24\.04"$/m);
			// The harness's generated basename is the complete grammar: no AppArmor
			// variables, quotes, glob syntax, escaping, controls, or arbitrary paths.
			assert.match(owned, /^\/tmp\/Hipi GUI 中文 验证-[A-Za-z0-9]{6}$/u);
			assert.equal(binary, posix.join(owned, "真实 应用", "hipi-work"));
			for (const [path, file] of [
				[owned, false],
				[posix.join(owned, "真实 应用"), false],
				[binary, true],
			]) {
				assert.equal(await io.realpath(path), path, "Policy target must be canonical");
				const stat = await io.lstat(path);
				assert.equal(stat.uid, io.uid(), "Policy target must be runner owned");
				assert.equal(stat.isSymbolicLink(), false, "Policy target cannot be a symlink");
				assert.ok(file ? stat.isFile() : stat.isDirectory());
				assert.equal(stat.mode & 0o022, 0, "Policy target cannot be group/world writable");
				if (file) assert.equal(stat.mode & 0o6000, 0, "Policy target cannot be set-id");
			}
			name = `hipi-sidebar-once-34-${createHash("sha256").update(binary).digest("hex").slice(0, 24)}`;
			// Ubuntu Noble ABI 4 userns exception, attached only to this literal path.
			// https://github.com/ubuntu/ubuntu-release-notes/blob/main/docs/24.04/index.md
			profile = `abi <abi/4.0>,\nprofile ${name} "${binary}" flags=(unconfined) {\n  userns,\n}\n`;
			baseline = await globals();
			assert.equal(baseline[globalPaths[0]], "1", "Expected Ubuntu userns restriction enabled");
			assert.equal(baseline[globalPaths[3]], "Y", "AppArmor must remain enabled");
			assert.equal(present(), false, "Existing policy name collision; never overwrite or remove");
			evidence.profileName = name;
			evidence.exactExecutable = binary;
			evidence.profileSha256 = createHash("sha256").update(profile).digest("hex");
			evidence.globalBefore = baseline;
			evidence.setup = "loading";
			// No policy files or cache writes: stdin is supported by apparmor_parser.
			// --add refuses a collision; never use --replace.
			io.run(["/sbin/apparmor_parser", "--add", "--skip-cache", "--config-file=/dev/null"], profile);
			loaded = true;
			evidence.cleanup = "pending";
			assert.equal(present(), true, "Loaded policy not visible");
			evidence.setup = "loaded";
		},
		async assertAttached(pid, iteration) {
			if (!evidence.eligible) return;
			assert.ok(loaded, "Policy must load before launch");
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			const attachment = (await io.readFile(`/proc/${pid}/attr/current`, "utf8")).trim();
			assert.equal(attachment, `${name} (unconfined)`, "Application did not attach the exact temporary policy");
			evidence.attachments.push({ iteration, pid, attachment });
		},
		async cleanup(assertStopped) {
			if (!loaded) {
				if (evidence.setup === "loading") {
					evidence.cleanup = "load outcome uncertain; no unrelated policy removed";
					throw new Error("Policy load outcome uncertain; retain owned fixture and fail closed");
				}
				return;
			}
			await assertStopped();
			const labels = io.run(["/usr/bin/ps", "-e", "-ww", "-o", "label="]);
			const observed = labels
				.trim()
				.split("\n")
				.map((label) => label.trim());
			assert.ok(
				observed.length > 0 && observed.every((label) => label && !["-", "?"].includes(label)),
				"Process policy labels unavailable",
			);
			assert.ok(!labels.split("\n").some((label) => label.includes(name)), "Processes still carry temporary policy");
			evidence.cleanup = "removal_pending";
			io.run(["/sbin/apparmor_parser", "--remove", "--skip-cache", "--config-file=/dev/null"], profile);
			loaded = false;
			assert.equal(present(), false, "Temporary policy remains loaded");
			evidence.cleanup = "removed_after_owned_process_shutdown";
			evidence.globalAfter = await globals();
			assert.deepEqual(evidence.globalAfter, baseline, "Global sandbox settings changed");
			evidence.globalSettingsUnchanged = true;
		},
	};
}
