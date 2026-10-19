import { join } from "node:path";

/** Node utility/worker entrypoints need real files, not virtual ASAR members. */
export function runtimeResource(root: string): string {
	const unpacked = root.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
	return join(unpacked, "runtime.mjs");
}
