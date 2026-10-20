import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export const nativeLogLimit = 1024 * 1024;
const workExperiencePhases = new Set([
	"draft",
	"settings",
	"matrix",
	"sidebar",
	"composer",
	"files",
	"credential_open",
	"credential_close",
	"restoration",
]);
const smokeMarkers = new Set([
	...[
		"status-enter",
		"availability-enter",
		"availability-return",
		"file-read-enter",
		"file-read-return",
		"status-return",
		"async-ready-enter",
		"async-ready-return",
		"probe-encrypt-enter",
		"probe-encrypt-return",
		"probe-decrypt-enter",
		"probe-decrypt-return",
	].map((phase) => `[Hipi smoke credential-status] ${phase}`),
	...["quit-request", "window-closed", "runtime-close-enter", "runtime-close-return", "app-exit-enter"].map(
		(phase) => `[Hipi smoke host-lifecycle] ${phase}`,
	),
]);
const packageExitPhases = new Set([
	"helper-start",
	"start",
	"import-enter",
	"import-return",
	"query",
	"query-return",
	"present",
	"absent",
	"output-invalid",
]);

export function recordGuiFailure(evidence, field, error, roots) {
	assert.ok(field === "failure" || field === "cleanupFailure");
	const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
	evidence[field] = redactNativeLog(
		typeof message === "string" ? message.slice(0, 4096) : "Unknown native failure",
		roots,
	).slice(0, 2000);
	const causes = [];
	const seen = new Set();
	delete evidence[`${field}Phase`];
	delete evidence[`${field}Causes`];
	delete evidence[`${field}PackageExitPhase`];
	if (field === "cleanupFailure") {
		delete evidence.cleanupFailureCommand;
		if (error instanceof Error) {
			const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
			const killed = Object.getOwnPropertyDescriptor(error, "killed")?.value;
			const signal = Object.getOwnPropertyDescriptor(error, "signal")?.value;
			const category =
				code === "ETIMEDOUT"
					? "timeout"
					: code === null && killed === true && signal === "SIGTERM"
						? "terminated"
						: Number.isSafeInteger(code) && code !== 0
							? "nonzero-exit"
							: undefined;
			if (category) {
				const stderr = Object.getOwnPropertyDescriptor(error, "stderr")?.value;
				const marker =
					typeof stderr === "string"
						? stderr
								.slice(0, 4096)
								.match(
									/\b(?:PSSecurityException|CommandNotFoundException|CimException|UnauthorizedAccessException)\b/,
								)?.[0]
						: undefined;
				evidence.cleanupFailureCommand = { category, ...(marker ? { powershellMarker: marker } : {}) };
			}
		}
	}
	function visit(value, depth) {
		if (!(value instanceof Error) || depth > 3 || causes.length >= 6 || seen.has(value)) return;
		seen.add(value);
		// Own data properties only: do not invoke accessors or serialize stacks, stderr or arbitrary objects.
		const phase = Object.getOwnPropertyDescriptor(value, "workExperiencePhase")?.value;
		const packageExitPhase = Object.getOwnPropertyDescriptor(value, "packageExitPhase")?.value;
		if (depth === 0) {
			if (workExperiencePhases.has(phase)) evidence[`${field}Phase`] = phase;
			if (packageExitPhases.has(packageExitPhase)) evidence[`${field}PackageExitPhase`] = packageExitPhase;
		} else {
			const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
			causes.push({
				message: redactNativeLog(
					typeof message === "string" ? message.slice(0, 4096) : "Unknown native failure",
					roots,
				).slice(0, 500),
				...(workExperiencePhases.has(phase) ? { phase } : {}),
				...(packageExitPhases.has(packageExitPhase) ? { packageExitPhase } : {}),
			});
		}
		if (depth === 3) return;
		if (value instanceof AggregateError) {
			const errors = Object.getOwnPropertyDescriptor(value, "errors")?.value;
			if (Array.isArray(errors))
				for (let index = 0; index < Math.min(errors.length, 6) && causes.length < 6; index++)
					visit(Object.getOwnPropertyDescriptor(errors, String(index))?.value, depth + 1);
		}
		visit(Object.getOwnPropertyDescriptor(value, "cause")?.value, depth + 1);
	}
	visit(error, 0);
	if (causes.length > 0) evidence[`${field}Causes`] = causes;
}

export function recordRendererError(evidence, iteration, method, params, roots) {
	if (evidence.errors.length >= 50) throw new Error("Renderer error log overflow");
	evidence.errors.push({ iteration, method, detail: redactNativeLog(JSON.stringify(params), roots).slice(0, 2000) });
}

export function redactNativeLog(text, roots) {
	for (const root of roots) text = text.replaceAll(root, "<owned-directory>");
	return text
		.replace(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/[^\s]+/g, "<private-debugger>")
		.split(/\r\n|[\r\n]/)
		.map((line) => {
			// Only these complete fixed smoke markers may bypass sensitive-line redaction.
			if (smokeMarkers.has(line)) return line;
			// Normalize Chromium's timestamp/module envelope before treating slashes as private paths.
			const envelope = line.match(
				/^\[(?:\d+:){1,2}\d{4}\/\d{6}\.\d{3,6}:(INFO|WARNING|ERROR|FATAL|VERBOSE\d*):[A-Za-z0-9_./-]+(?::\d+|\(\d+\))\]\s*/,
			);
			const prefix = envelope ? `[Chromium ${envelope[1]}] ` : "";
			if (envelope) line = line.slice(envelope[0].length);
			if (
				/authorization|bearer|api[_-]?key|password|credential|host-lifecycle|token\s*[=:]|\b[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(
					line,
				)
			) {
				const reason =
					line.match(
						/\b(?:TypeError|SyntaxError|RangeError|ReferenceError|Error|EACCES|EPERM|ENOENT|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM)\b/g,
					) ?? [];
				return `${prefix}<redacted-sensitive-line>${reason.length ? ` ${[...new Set(reason)].join(" ")}` : ""}`;
			}
			// Unknown absolute paths may contain spaces. Discard the remainder rather than expose a suffix.
			// This also handles Windows case/slash variants, UNC and file URLs without knowing a user's home.
			return prefix + line.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/).*$/g, "<absolute-path>");
		})
		.join("\n");
}

export async function readNativeLog(directory, iteration, roots) {
	assert.ok(iteration === 0 || iteration === 1);
	// Match the owned root's canonicalizer; Windows native and JS walks can spell it differently.
	assert.ok(realpathSync(directory) === directory, "Native log directory must be exactly canonical");
	const path = join(directory, `chromium-${iteration}.log`);
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return { exists: false, overflow: false, text: "" };
		throw error;
	}
	assert.ok(info.isFile() && !info.isSymbolicLink(), "Native log must be an owned regular file");
	const handle = await open(path, "r");
	try {
		const opened = await handle.stat();
		assert.equal(opened.ino, info.ino);
		assert.equal(opened.dev, info.dev);
		const bytes = Buffer.alloc(nativeLogLimit);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const text = redactNativeLog(bytes.subarray(0, bytesRead).toString("utf8"), roots);
		return {
			exists: true,
			overflow: opened.size > nativeLogLimit,
			text: Buffer.from(text)
				.subarray(0, nativeLogLimit - 3)
				.toString("utf8"),
		};
	} finally {
		await handle.close();
	}
}

export async function withNativeLogBudget(operation, check) {
	let stopped = false;
	let timer;
	let wake;
	const monitor = (async () => {
		while (!stopped) {
			assert.equal((await check()).overflow, false, "Native file logging exceeded 1 MiB");
			if (stopped) return;
			await new Promise((resolve) => {
				wake = resolve;
				timer = setTimeout(resolve, 100);
			});
		}
	})();
	try {
		const result = await Promise.race([operation(), monitor]);
		assert.equal((await check()).overflow, false, "Native file logging exceeded 1 MiB");
		return result;
	} finally {
		stopped = true;
		clearTimeout(timer);
		wake?.();
		await monitor.catch(() => {});
	}
}
