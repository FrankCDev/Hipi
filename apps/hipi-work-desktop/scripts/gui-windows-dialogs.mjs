import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./gui-windows-dialogs.ps1", import.meta.url));
const codes = new Set([
	"IDENTITY_CHANGED",
	"UNKNOWN_DIALOG",
	"OWNED_ERROR_DIALOG",
	"TASK_DIALOG_TEXT_OBSERVED",
	"DIRECTUI_CONTROL_OBSERVED",
	"SYSLINK_CONTROL_OBSERVED",
	"STATIC_CONTROL_OBSERVED",
	"UIA_ROOT_OBSERVED",
	"UIA_TEXT_EMPTY",
	"UIA_PANE_OBSERVED",
	"UIA_HYPERLINK_OBSERVED",
	"UIA_CUSTOM_OBSERVED",
	"UIA_BUTTON_OBSERVED",
	"UIA_WINDOW_OBSERVED",
	"UIA_OTHER_OBSERVED",
	"UIA_TIME_LIMIT",
	"UIA_ROOT_BIND_TIME_LIMIT",
	"UIA_CONTROL_LIMIT",
	"UIA_DEPTH_LIMIT",
	"NATIVE_TIME_LIMIT",
	"NATIVE_CONTROL_LIMIT",
	"NATIVE_WINDOW_LIMIT",
	"TEXT_UNAVAILABLE",
	"TEXT_TRUNCATED",
	"ELECTRON_MAIN_JS_ERROR",
	"SyntaxError",
	"ReferenceError",
	"TypeError",
	"ERR_MODULE_NOT_FOUND",
	"ERR_UNSUPPORTED_ESM_URL_SCHEME",
	"ENOENT",
	"EACCES",
	"EPERM",
	"HIPI_STARTUP_FAILED",
	"LIMIT_REACHED",
	"NO_MATCHING_DIALOG_OBSERVED",
	"ENUMERATION_UNAVAILABLE",
]);
const reasons = new Set([
	"utility-import",
	"request",
	"process-lookup",
	"process-handle",
	"process-start-time",
	"process-session",
	"process-image",
	"session-mismatch",
	"image-mismatch",
	"process-exited",
	"spawn-window",
	"capture-identity",
	"uia-apartment",
	"uia-root-bind",
	"uia-read",
	"native-compile",
	"native-query",
	"post-query-identity",
	"helper-timeout",
	"helper-exit",
	"helper-policy-denied",
	"helper-output",
	"owned-window-query-unavailable",
]);
const phases = new Set(
	[...reasons].filter((value) => !value.startsWith("helper-") && value !== "owned-window-query-unavailable"),
);
const unknown = (reason, lastPhase) => ({
	status: "unknown",
	reason: reasons.has(reason) ? reason : "owned-window-query-unavailable",
	...(phases.has(lastPhase) || lastPhase === "helper-start" ? { lastPhase } : {}),
});

// Progress is diagnostic only, never proof of identity. Ignore an incomplete final line.
function progress(stdout) {
	if (typeof stdout !== "string" || stdout.length > 16 * 1024) return "helper-start";
	let lastPhase = "helper-start";
	for (const line of stdout
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.slice(0, -1)) {
		try {
			const item = JSON.parse(line);
			if (item && Object.keys(item).length === 1 && phases.has(item.phase)) lastPhase = item.phase;
		} catch {
			/* Never expose non-protocol output. */
		}
	}
	return lastPhase;
}

function finalResult(stdout) {
	const lines = stdout
		.replace(/^\uFEFF/, "")
		.trim()
		.split(/\r?\n/);
	const result = JSON.parse(lines.pop());
	for (const line of lines) {
		const item = JSON.parse(line);
		if (!item || Object.keys(item).length !== 1 || !phases.has(item.phase)) throw Error("Invalid progress");
	}
	return result;
}

async function query(request, run) {
	try {
		// UI Automation runs in a window-free MTA helper, not PowerShell's default STA.
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Mta", "-File", script], {
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(name)),
				),
				HIPI_WINDOW_REQUEST: JSON.stringify(request),
			},
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 16 * 1024,
		});
		if (typeof stdout !== "string" || stdout.length > 16 * 1024) return unknown("helper-output");
		try {
			return finalResult(stdout);
		} catch {
			return unknown("helper-output");
		}
	} catch (error) {
		if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return unknown("helper-output");
		// Classify only a fixed PowerShell security marker; never expose its text/path.
		if (typeof error?.stderr === "string" && /\bPSSecurityException\b/.test(error.stderr))
			return unknown("helper-policy-denied");
		return unknown(error?.killed ? "helper-timeout" : "helper-exit", progress(error?.stdout));
	}
}

/** Bind to the original spawn timestamp. Identity is private harness state, not evidence output. */
export async function captureWindowsIdentity(input, { platform = process.platform, run = execute } = {}) {
	if (platform !== "win32") return { status: "not-applicable" };
	if (
		!Number.isSafeInteger(input.pid) ||
		input.pid <= 0 ||
		typeof input.binary !== "string" ||
		!Number.isSafeInteger(input.spawnedAt)
	)
		return unknown();
	const result = await query({ mode: "identity", ...input }, run);
	if (result?.status === "unknown") return unknown(result.reason, result.lastPhase);
	if (
		result?.status !== "confirmed" ||
		result.pid !== input.pid ||
		!/^\d{1,20}$/.test(result.startTicks) ||
		!Number.isSafeInteger(result.session) ||
		result.session < 0
	)
		return unknown();
	return {
		status: "confirmed",
		pid: input.pid,
		binary: input.binary,
		startTicks: result.startTicks,
		session: result.session,
	};
}

/** Read only the verified main process's error dialogs, before existing termination logic. */
export async function readWindowsDialogs(identity, { platform = process.platform, run = execute } = {}) {
	if (platform !== "win32") return { status: "not-applicable" };
	if (identity?.status !== "confirmed") return unknown(identity?.reason, identity?.lastPhase);
	const result = await query(
		{
			mode: "capture",
			pid: identity.pid,
			binary: identity.binary,
			startTicks: identity.startTicks,
			session: identity.session,
		},
		run,
	);
	if (result?.status === "unknown") return unknown(result.reason, result.lastPhase);
	if (
		result?.status !== "observed" ||
		!Array.isArray(result.codes) ||
		result.codes.length > codes.size ||
		result.codes.some((code) => !codes.has(code))
	)
		return unknown();
	// Copy only reviewed constants. Unknown fields/raw native text never leave this boundary.
	if (result.codes.includes("IDENTITY_CHANGED") || result.codes.includes("ENUMERATION_UNAVAILABLE")) return unknown();
	return { status: "observed", codes: [...new Set(result.codes)].sort() };
}
