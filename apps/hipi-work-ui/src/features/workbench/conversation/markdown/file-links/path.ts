import { validateRelativePath } from "@hipi/work-runtime/files";

/** A project-relative reference, never a browser URL or a filesystem authority. */
export function projectFilePath(destination: string | undefined): string | undefined {
	if (!destination || /[#?]/u.test(destination)) return undefined;
	try {
		// Markdown URI serialization escapes Unicode and spaces. Decode those only;
		// encoded ASCII separators, dots, schemes, controls and double-encoding stay inert.
		if (/%(?!20|[89a-f][\da-f])[\da-f]{2}/iu.test(destination)) return undefined;
		const path = decodeURIComponent(destination);
		return validateRelativePath(path.startsWith("./") ? path.slice(2) : path);
	} catch {
		return undefined;
	}
}
