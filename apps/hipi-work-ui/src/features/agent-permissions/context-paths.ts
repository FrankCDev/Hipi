import { AGENT_LIMITS } from "@hipi/work-runtime/contracts";
import { validateRelativePath } from "@hipi/work-runtime/files";

/** Preserve exact path spelling; whole-root permission requires its own explicit choice. */
export function contextPaths(text: string, wholeRoot: boolean): string[] | null {
	if (wholeRoot) return [""];
	const paths = text.split("\n");
	if (paths.length > AGENT_LIMITS.pathPrefixes || new Set(paths).size !== paths.length) return null;
	try {
		return paths.map((path) => validateRelativePath(path));
	} catch {
		return null;
	}
}
