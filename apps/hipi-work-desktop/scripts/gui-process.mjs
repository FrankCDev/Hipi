import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { until } from "./gui-flow.mjs";

const execute = promisify(execFile);

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

export async function assertNoPackageProcesses(appDirectory) {
	if (process.platform === "win32") {
		// Fixed command; path is passed as data, never interpolated into PowerShell source.
		const result = await execute(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$p = $env:HIPI_SMOKE_PACKAGE; $found = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }); if ($found.Count -ne 0) { exit 2 }",
			],
			{
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR)$/i.test(name)),
					),
					HIPI_SMOKE_PACKAGE: appDirectory,
				},
				windowsHide: true,
				timeout: 15000,
				maxBuffer: 1024 * 1024,
			},
		);
		return result;
	}
	const result = await execute("ps", ["-ww", "-axo", "pid=,command="], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
	if (result.stdout.split("\n").some((line) => line.includes(`${appDirectory}/`)))
		throw new Error("Packaged helper still alive");
}
