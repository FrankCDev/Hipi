export const LOG_LIMITS = Object.freeze({
	fileBytes: 5 * 1024 * 1024,
	recordBytes: 1024,
	retentionDays: 14,
	closeWaitMs: 2000,
});
export const events = Object.freeze({
	"app.start": "info",
	"app.ready": "info",
	"app.stop": "info",
	"app.failed": "error",
	"runtime.start": "info",
	"runtime.ready": "info",
	"runtime.unavailable": "warn",
	"runtime.shutdown-timeout": "error",
	"runtime.diagnostic": "error",
	"renderer.gone": "error",
	"request.completed": "debug",
	"request.failed": "warn",
	"diagnostics.export": "info",
	"dev.start": "info",
	"dev.build": "info",
	"dev.ready": "info",
	"dev.restart": "info",
	"dev.stop": "info",
	"dev.failed": "error",
	"dev.server.ready": "info",
	"dev.build.started": "info",
	"dev.build.ready": "info",
	"dev.desktop.starting": "info",
	"dev.desktop.ready": "info",
	"dev.desktop.exited": "info",
	"dev.restart.requested": "info",
	"dev.shutdown.requested": "info",
	"dev.shutdown.waiting": "info",
	"dev.stopped": "info",
	"dev.build.failed": "error",
	"dev.usage.invalid": "error",
	"dev.models.missing": "error",
	"dev.electron.missing": "error",
	"dev.shutdown.failed": "error",
	"dev.server.failed": "error",
	"dev.desktop.failed": "error",
	"dev.startup.failed": "error",
});
// Terminal guidance is fixed product copy, never exception text or caller data.
export const descriptions = Object.freeze({
	"dev.start": "Starting desktop development.",
	"dev.build": "Building desktop processes.",
	"dev.ready": "Desktop development is ready.",
	"dev.restart": "Restarting desktop after a successful build.",
	"dev.stop": "Stopping desktop development.",
	"dev.failed": "Desktop development failed. Check the preceding diagnostics.",
	"dev.server.ready": "Local renderer server is ready on 127.0.0.1:5173.",
	"dev.build.started": "Building desktop processes.",
	"dev.build.ready": "Desktop build is ready.",
	"dev.desktop.starting": "Starting the desktop application.",
	"dev.desktop.ready":
		"Desktop is ready. Renderer edits refresh automatically; host edits restart after successful builds.",
	"dev.desktop.exited": "Desktop process exited.",
	"dev.restart.requested": "Waiting for orderly desktop shutdown before restart.",
	"dev.shutdown.requested": "Stopping watchers and requesting orderly desktop shutdown.",
	"dev.shutdown.waiting":
		"Waiting for desktop shutdown. Save or discard unsaved edits, or close its recovery dialog. No process is force-killed.",
	"dev.stopped": "Desktop development stopped.",
	"dev.build.failed":
		"Build failed. Fix the compiler diagnostics; no new desktop restart is requested until a successful build.",
	"dev.usage.invalid": "Use --provider=production or --provider=deterministic.",
	"dev.models.missing":
		"Model data is missing or stale. Run npm run hydrate:model-data, then npm run check:model-data.",
	"dev.electron.missing":
		"Electron binary is missing. Complete the Electron installation step in apps/hipi-work-desktop/README.md. Development never downloads executables automatically.",
	"dev.shutdown.failed":
		"Desktop shutdown could not be confirmed. Inspect the desktop before restarting; its profile will not be reopened automatically.",
	"dev.server.failed":
		"Local renderer server could not start. Check whether port 5173 is already occupied and review the compiler diagnostics.",
	"dev.desktop.failed":
		"Desktop startup or restart failed. Inspect the desktop and preceding diagnostics before retrying.",
	"dev.startup.failed":
		"Development setup failed. Check the documented prerequisites and local output-directory permissions before retrying.",
});
const stages = new Set([
	"runtime-open",
	"file-services-open",
	"storage-open",
	"file-services-close",
	"subscriptions-close",
	"runtime-close",
	"dispatch",
	"unknown",
	"prepare",
	"renderer",
	"host",
	"prerequisite",
]);
const outcomes = new Set([
	"success",
	"failed",
	"cancelled",
	"busy",
	"write-unknown",
	"closed",
	"saved",
	"clean",
	"unclean",
]);
const categories = new Set(["startup", "storage", "close", "operation"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Copy only known scalar fields. Never serialize caller objects, Error, toJSON, request data or environment.
export function contextFields(context) {
	const result = {};
	if (!context || typeof context !== "object") return result;
	for (const [key, allowed] of [
		["stage", stages],
		["outcome", outcomes],
		["category", categories],
	]) {
		const value = Object.getOwnPropertyDescriptor(context, key)?.value;
		if (allowed.has(value)) result[key] = value;
	}
	for (const key of ["requestId", "generation"]) {
		const value = Object.getOwnPropertyDescriptor(context, key)?.value;
		if (typeof value === "string" && uuid.test(value)) result[key] = value;
	}
	for (const key of ["durationMs", "exitCode"]) {
		const value = Object.getOwnPropertyDescriptor(context, key)?.value;
		if (Number.isFinite(value)) result[key] = Math.max(0, Math.min(86400000, Math.round(value)));
	}
	return result;
}
