import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { until } from "./gui-flow.mjs";

const execute = promisify(execFile);
const packageExitCommand = [
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:start'); [Console]::Out.Flush();",
	// Resolve only the in-box module, not user/installed modules through implicit discovery.
	"$PSModuleAutoLoadingPreference = 'None';",
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:import-enter'); [Console]::Out.Flush();",
	"Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\\CimCmdlets\\CimCmdlets.psd1')) -ErrorAction Stop;",
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:import-return'); [Console]::Out.Flush();",
	"$p = $env:HIPI_SMOKE_PACKAGE;",
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:query'); [Console]::Out.Flush();",
	"$found = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) });",
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:query-return'); [Console]::Out.Flush();",
	"if ($found.Count -ne 0) { [Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:present'); [Console]::Out.Flush(); exit 2 }",
	"[Console]::Out.WriteLine('HIPI_PACKAGE_EXIT_PHASE:absent'); [Console]::Out.Flush();",
].join(" ");

function packageExitProgress(stdout) {
	if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 4096) return { phase: "output-invalid" };
	const lines = stdout.replace(/^\uFEFF/, "").split(/\r?\n/);
	const remainder = lines.pop();
	let phase = "helper-start";
	const stages = ["start", "import-enter", "import-return", "query", "query-return"];
	for (const [index, line] of lines.entries()) {
		const value = line.slice("HIPI_PACKAGE_EXIT_PHASE:".length);
		if (
			!line.startsWith("HIPI_PACKAGE_EXIT_PHASE:") ||
			(index < stages.length
				? value !== stages[index]
				: index !== stages.length || !["present", "absent"].includes(value))
		)
			return { phase: "output-invalid" };
		phase = value;
	}
	// Incomplete progress is diagnostic only, never an absence/presence result.
	return { phase, ...(remainder === "" && lines.length === stages.length + 1 ? { outcome: phase } : {}) };
}

/** Observe the unchanged package-path filter; never authorize cleanup from missing protocol output. */
export async function queryWindowsPackageExit(appDirectory, timeout, run = execute) {
	let result;
	try {
		result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", packageExitCommand], {
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR)$/i.test(name))),
				HIPI_SMOKE_PACKAGE: appDirectory,
			},
			windowsHide: true,
			timeout,
			maxBuffer: 1024 * 1024,
		});
	} catch (error) {
		const progress = packageExitProgress(error?.stdout);
		if (error?.code === 2 && (progress.outcome !== "present" || error.stderr !== "")) {
			throw Object.assign(new Error("Packaged exit observation did not confirm a result"), {
				packageExitPhase: progress.phase,
			});
		}
		if (error instanceof Error) error.packageExitPhase = progress.phase;
		throw error;
	}
	const progress = packageExitProgress(result.stdout);
	if (progress.outcome !== "absent" || result.stderr !== "")
		throw Object.assign(new Error("Packaged exit observation did not confirm a result"), {
			packageExitPhase: progress.phase,
		});
}

export function debuggerClosed(port) {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Debugger close probe timed out"));
		}, 2000);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			socket.destroy();
			if (error.code === "ECONNREFUSED") resolve(true);
			else reject(error);
		});
	});
}
export function startProcess(binary, args, options) {
	const child = spawn(binary, args, {
		...options,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let closed = false;
	let exited = false;
	let output = "";
	let overflow = false;
	const append = (chunk) => {
		if (output.length + chunk.length > 1024 * 1024) {
			overflow = true;
			return;
		}
		output += chunk.toString("utf8");
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	const completion = new Promise((resolve) => {
		child.once("exit", () => {
			exited = true;
		});
		child.once("error", (error) => {
			output += `\nSpawn failed: ${error.message}`;
		});
		child.once("close", (code, signal) => {
			closed = true;
			resolve({ code, signal });
		});
	});
	return {
		child,
		completion,
		get exited() {
			return exited;
		},
		get closed() {
			return closed;
		},
		get output() {
			return output;
		},
		get overflow() {
			return overflow;
		},
		async wait(milliseconds = 30000) {
			await until(() => closed, "native process close", milliseconds);
			return completion;
		},
		async terminate() {
			// A closed child's numeric PID/PGID may already identify a different process.
			if (closed) return completion;
			// Inherited stdio may keep close pending after the process itself has exited.
			if (exited || child.exitCode !== null || child.signalCode !== null) return this.wait();
			if (process.platform === "win32") {
				if (!closed && child.pid)
					await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15000 });
			} else if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
			}
			await this.wait();
		},
	};
}

export async function waitForCimExit(
	query,
	{ milliseconds = 10000, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
	const deadline = now() + milliseconds;
	while (now() < deadline) {
		try {
			await query(Math.max(1, deadline - now()));
			if (now() >= deadline) break;
			return;
		} catch (error) {
			if (error.code !== 2) throw error;
		}
		const remaining = deadline - now();
		if (remaining > 0) await pause(Math.min(250, remaining));
	}
	throw new Error("Packaged helpers remain or exit observation exceeded its deadline");
}

export async function assertNoPackageProcesses(appDirectory) {
	if (process.platform === "win32") {
		// Fixed command; path is passed as data, never interpolated into PowerShell source.
		await waitForCimExit((timeout) => queryWindowsPackageExit(appDirectory, timeout));
		return;
	}
	const result = await execute("ps", ["-ww", "-axo", "pid=,command="], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
	if (result.stdout.split("\n").some((line) => line.includes(`${appDirectory}/`)))
		throw new Error("Packaged helper still alive");
}
