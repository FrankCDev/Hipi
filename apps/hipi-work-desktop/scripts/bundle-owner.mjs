import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function within(root, path) {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

function packageBoundary(path, lock) {
	if (Object.hasOwn(lock.packages, path)) return true;
	const parts = path.split("/");
	const index = parts.lastIndexOf("node_modules");
	const tail = parts.slice(index + 1);
	return (
		index >= 0 && ((tail.length === 1 && !tail[0].startsWith("@")) || (tail.length === 2 && tail[0].startsWith("@")))
	);
}

/** Resolve retained inputs to their real locked distribution/workspace owner.
 * A nested type-only package.json establishes module semantics, not attribution.
 */
export async function resolveBundleOwner(root, input, lock) {
	assert.ok(
		typeof input === "string" &&
			input.length > 0 &&
			!isAbsolute(input) &&
			!input.includes("\\") &&
			!input.includes("\0") &&
			!/^[A-Za-z]:/.test(input) &&
			input.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
		"Invalid bundle input path",
	);
	assert.ok(lock?.packages && typeof lock.packages === "object", "Missing package lock owners");
	const canonicalRoot = await realpath(root);
	const source = resolve(canonicalRoot, input);
	assert.ok(within(canonicalRoot, source), "Bundle input escapes repository");
	assert.ok((await lstat(source)).isFile(), "Bundle input must be a regular file");
	const canonicalSource = await realpath(source);
	assert.ok(within(canonicalRoot, canonicalSource), "Bundle input resolves outside repository");
	let location = dirname(canonicalSource);
	while (within(canonicalRoot, location)) {
		const key = relative(canonicalRoot, location).replaceAll("\\", "/");
		const boundary = packageBoundary(key, lock);
		const manifest = join(location, "package.json");
		let info;
		try {
			assert.ok((await lstat(manifest)).isFile(), "Bundle owner manifest must be a regular file");
			info = JSON.parse(await readFile(manifest, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			assert.ok(!boundary, "Locked bundle owner manifest is missing");
		}
		if (info !== undefined) {
			assert.ok(info && typeof info === "object" && !Array.isArray(info), "Invalid bundle owner manifest");
			if (!Object.hasOwn(info, "version") && Object.hasOwn(info, "name") && info.private === true && !boundary) {
				// Preact's private hooks/jsx-runtime subpath descriptors have a
				// name but no distribution version. The locked parent owns them.
				assert.match(info.name, /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i, "Invalid subpath name");
			} else if (!Object.hasOwn(info, "name") && !Object.hasOwn(info, "version")) {
				assert.ok(
					!boundary &&
						(info.type === "module" || info.type === "commonjs") &&
						Object.keys(info).every((field) => field === "type" || field === "sideEffects") &&
						(info.sideEffects === undefined || typeof info.sideEffects === "boolean"),
					"Nameless bundle owner is not a nested module-scope manifest",
				);
			} else {
				assert.match(info.name, /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i, "Invalid bundle owner name");
				assert.match(info.version, /^[0-9][0-9A-Za-z.+_-]*$/, "Invalid bundle owner version");
				const locked = lock.packages[key];
				assert.ok(locked && typeof locked === "object", "Bundle owner is not at its locked package path");
				assert.equal(locked.version, info.version, "Bundle owner locked version changed");
				if (locked.name !== undefined) assert.equal(locked.name, info.name, "Bundle owner locked name changed");
				return { location, key, info, locked };
			}
		}
		if (location === canonicalRoot) break;
		location = dirname(location);
	}
	throw new Error("Bundle input has no named locked package owner");
}
