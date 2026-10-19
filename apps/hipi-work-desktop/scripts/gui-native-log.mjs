import assert from "node:assert/strict";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

export const nativeLogLimit = 1024 * 1024;

export function recordGuiFailure(evidence, field, error, roots) {
	assert.ok(field === "failure" || field === "cleanupFailure");
	evidence[field] = redactNativeLog(error instanceof Error ? error.message : "Unknown native failure", roots).slice(
		0,
		2000,
	);
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
			// Normalize Chromium's timestamp/module envelope before treating slashes as private paths.
			const envelope = line.match(
				/^\[(?:\d+:){1,2}\d{4}\/\d{6}\.\d{3,6}:(INFO|WARNING|ERROR|FATAL|VERBOSE\d*):[A-Za-z0-9_./-]+(?::\d+|\(\d+\))\]\s*/,
			);
			const prefix = envelope ? `[Chromium ${envelope[1]}] ` : "";
			if (envelope) line = line.slice(envelope[0].length);
			if (
				/authorization|bearer|api[_-]?key|password|credential|token\s*[=:]|\b[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(line)
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
	assert.equal(await realpath(directory), directory);
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
