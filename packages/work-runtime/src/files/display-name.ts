import { basename } from "node:path";

/** Display-only basename. A hidden label never changes the root's identity or authorization. */
export function rootDisplayName(canonicalPath: string): string | undefined {
	const name = basename(canonicalPath);
	return name && [...name].length <= 255 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name) ? name : undefined;
}
