import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const candidates = [
	"profile",
	"session",
	"logs",
	"crashes",
	"session/DevToolsActivePort",
	"profile/DevToolsActivePort",
	"profile/deterministic-store",
	"profile/deterministic-store/catalog.sqlite",
	"profile/deterministic-store/store-owner.sqlite",
];

/** Metadata only, at fixed paths within the caller's own mkdtemp root. Never follow a link. */
export async function profileEvidence(root) {
	const evidence = [];
	for (const candidate of candidates) {
		const parts = candidate.split("/");
		let entry = { path: candidate, exists: false };
		try {
			const rootStat = await lstat(root);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("UNSAFE_ROOT");
			for (let index = 0; index < parts.length; index++) {
				const stat = await lstat(join(root, ...parts.slice(0, index + 1)));
				if (index < parts.length - 1 && (!stat.isDirectory() || stat.isSymbolicLink())) {
					entry = { path: candidate, exists: false, blockedAncestor: parts.slice(0, index + 1).join("/") };
					break;
				}
				if (index === parts.length - 1)
					entry = {
						path: candidate,
						exists: true,
						type: stat.isSymbolicLink()
							? "symlink"
							: stat.isDirectory()
								? "directory"
								: stat.isFile()
									? "file"
									: "other",
						bytes: stat.size,
						modifiedAt: stat.mtime.toISOString(),
						canonicalEqual: stat.isSymbolicLink() ? false : realpathSync(join(root, ...parts)) === join(root, ...parts),
					};
			}
		} catch (error) {
			if (error.code !== "ENOENT")
				entry.error = error.code === "EACCES" || error.code === "EPERM" ? error.code : "UNAVAILABLE";
		}
		evidence.push(entry);
	}
	return evidence;
}

export async function profileRootEvidence(root) {
	try {
		return {
			canonicalEqual: realpathSync(root) === root,
			resolvedEqual: resolve(root) === root,
			parentMatchesTemporary: dirname(root) === realpathSync(tmpdir()),
		};
	} catch {
		return { unavailable: true };
	}
}
