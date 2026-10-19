import { mkdir, mkdtemp, open, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Diagnostic observations only. This does not qualify product or power-loss durability.
// Node's Windows fsync calls FlushFileBuffers, which requires write access:
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
// https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/fs.c
const report = {
	probe: "filesystem-sync",
	purpose: "diagnostic_only_not_product_acceptance",
	platform: process.platform,
	node: process.versions.node,
	uv: process.versions.uv,
	observations: [],
};
const expected = Buffer.from("Hipi filesystem sync probe: 中文\n", "utf8");
let root;
let safeToRemove = true;

function failure(error) {
	return {
		status: "error",
		code: typeof error?.code === "string" ? error.code : "UNCLASSIFIED",
		syscall: typeof error?.syscall === "string" ? error.syscall : null,
	};
}

try {
	root = await mkdtemp(join(await realpath(tmpdir()), "hipi-sync-probe-"));
	root = await realpath(root);
	const file = join(root, "payload.txt");
	const directory = join(root, "directory");
	await writeFile(file, expected, { flag: "wx" });
	await mkdir(directory);
	const filesystem = await statfs(root, { bigint: true });
	report.filesystem = { type: filesystem.type.toString(), blockSize: filesystem.bsize.toString() };
	for (const [kind, path] of [
		["file", file],
		["directory", directory],
	]) {
		for (const flags of ["r", "r+"]) {
			const observation = {
				kind,
				flags,
				open: { status: "not_attempted" },
				sync: { status: "not_attempted" },
				close: { status: "not_attempted" },
			};
			report.observations.push(observation);
			let handle;
			try {
				handle = await open(path, flags);
				observation.open = { status: "completed" };
			} catch (error) {
				observation.open = failure(error);
			}
			if (handle) {
				try {
					await handle.sync();
					observation.sync = { status: "completed" };
				} catch (error) {
					observation.sync = failure(error);
				} finally {
					try {
						await handle.close();
						observation.close = { status: "completed" };
					} catch (error) {
						observation.close = failure(error);
						safeToRemove = false;
						process.exitCode = 1;
					}
				}
			}
			observation.fileContentUnchanged = expected.equals(await readFile(file));
			if (!observation.fileContentUnchanged) process.exitCode = 1;
		}
	}
} catch (error) {
	report.probeError = failure(error);
	safeToRemove = false;
	process.exitCode = 1;
} finally {
	if (root && safeToRemove) {
		try {
			await rm(root, { recursive: true });
			report.fixture = "removed_after_handles_closed";
		} catch (error) {
			report.cleanupError = failure(error);
			report.fixture = "cleanup_unconfirmed";
			process.exitCode = 1;
		}
	} else {
		report.fixture = root ? "retained_due_to_unconfirmed_cleanup_safety" : "not_created";
	}
}
process.stdout.write(`${JSON.stringify(report)}\n`);
