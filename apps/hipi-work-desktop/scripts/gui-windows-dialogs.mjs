import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./gui-windows-dialogs.ps1", import.meta.url));
const codes = new Set([
	"IDENTITY_CHANGED",
	"UNKNOWN_DIALOG",
	"OWNED_ERROR_DIALOG",
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
const unknown = () => ({ status: "unknown", reason: "owned-window-query-unavailable" });

async function query(request, run) {
	try {
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
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
		if (typeof stdout !== "string" || stdout.length > 16 * 1024) return unknown();
		return JSON.parse(stdout.replace(/^\uFEFF/, ""));
	} catch {
		return unknown();
	}
}

/** Capture immediately after spawn. Identity is private harness state, not evidence output. */
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
	if (identity?.status !== "confirmed") return unknown();
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
