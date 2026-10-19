import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { release } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// Read-only host diagnostics. No security configuration or installed permissions change.
const report = {
	schemaVersion: 1,
	probe: "linux-sandbox-capability",
	status: "not_applicable",
	platform: process.platform,
	kernel: release(),
	node: process.versions.node,
	productGuiValidated: false,
};

async function executable(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter).slice(0, 128)) {
		if (!isAbsolute(directory)) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return await realpath(candidate);
		} catch {
			// A missing or inaccessible PATH entry is not an executable.
		}
	}
	return null;
}

if (process.platform === "linux") {
	report.status = "blocked";
	report.uid = process.geteuid();
	report.chromeSandboxHelper = { status: "unavailable" };
	try {
		const path = "/opt/google/chrome/chrome-sandbox";
		const info = await lstat(path);
		const resolved = await realpath(path);
		report.chromeSandboxHelper = {
			status: "metadata_only_not_executed",
			regularFile: info.isFile(),
			symlink: info.isSymbolicLink(),
			uid: info.uid,
			mode: (info.mode & 0o7777).toString(8),
			exactOfficialPath: resolved === path,
		};
		if (info.isFile() && resolved === path && info.size <= 8 * 1024 * 1024) {
			const bytes = await readFile(path);
			const after = await lstat(path);
			if (
				info.ino === after.ino &&
				info.dev === after.dev &&
				info.mtimeMs === after.mtimeMs &&
				bytes.length === info.size
			) {
				report.chromeSandboxHelper.sha256 = createHash("sha256").update(bytes).digest("hex");
			}
		}
	} catch (error) {
		report.chromeSandboxHelper.errorCode = typeof error?.code === "string" ? error.code : "UNCLASSIFIED";
	}
	report.sysctls = {};
	for (const [name, path] of [
		["apparmor_restrict_unprivileged_userns", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"],
		["unprivileged_userns_clone", "/proc/sys/kernel/unprivileged_userns_clone"],
		["max_user_namespaces", "/proc/sys/user/max_user_namespaces"],
	]) {
		try {
			const value = (await readFile(path, "utf8")).trim();
			report.sysctls[name] = /^\d{1,15}$/.test(value) ? Number(value) : "unavailable";
		} catch {
			report.sysctls[name] = "unavailable";
		}
	}
	try {
		const os = await readFile("/etc/os-release", "utf8");
		report.os = Object.fromEntries(
			["ID", "VERSION_ID"].map((key) => {
				const value = os.match(new RegExp(`^${key}="?([a-zA-Z0-9._-]+)"?$`, "m"))?.[1];
				return [key, value ?? "unavailable"];
			}),
		);
	} catch {
		report.os = { ID: "unavailable", VERSION_ID: "unavailable" };
	}
	const [xvfb, unshare, trueCommand] = await Promise.all([
		executable("Xvfb"),
		executable("unshare"),
		executable("true"),
	]);
	report.executables = { Xvfb: Boolean(xvfb), unshare: Boolean(unshare), true: Boolean(trueCommand) };
	report.namespace = { status: "not_attempted" };
	if (unshare && trueCommand) {
		// The child creates only ephemeral namespaces and exits. No host UID mapping is changed.
		const result = spawnSync(unshare, ["-Ur", trueCommand], {
			timeout: 5000,
			killSignal: "SIGKILL",
			maxBuffer: 4096,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
		});
		report.namespace = {
			status: result.status === 0 && !result.error ? "completed" : "blocked",
			exitCode: result.status,
			signal: result.signal,
			errorCode: result.error?.code ?? null,
			stderr: (result.stderr ?? "").trim().slice(0, 512),
		};
	}
	if (report.uid !== 0 && xvfb && report.namespace.status === "completed") {
		report.status = "candidate_requires_packaged_gui_validation";
	}
	if (report.status === "blocked") process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(report)}\n`);
