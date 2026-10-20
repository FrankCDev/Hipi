/** Browser-safe file port. Paths are slash-separated relative names, never URLs. */
export const FILE_LIMITS = { bytes: 131072, page: 50, directoryEntries: 4096, roots: 32, concurrent: 8 } as const;
export type FileTarget = { workspaceId: string; rootId: string; path: string };
export type FileRoot = { workspaceId: string; rootId: string; writable: boolean; displayName?: string };
/** Ephemeral native-picker result. No workspace or persistent access exists until explicit attach. */
export type ProjectFolderSelection = { selectionId: string; displayName: string | null };
/** Persistent local association, not Agent consent. Only an available folder has a live read-only root. */
export type ProjectFolder =
	| {
			workspaceId: string;
			status: "unbound";
			bindingId: null;
			revision: 0;
			displayName: null;
			root: null;
	  }
	| {
			workspaceId: string;
			status: "available";
			bindingId: string;
			revision: number;
			displayName: string | null;
			root: FileRoot;
	  }
	| {
			workspaceId: string;
			status: "unavailable" | "moved" | "revoked";
			bindingId: string;
			revision: number;
			displayName: string | null;
			root: null;
	  };
export type FileEntry = { name: string; path: string; kind: "file" | "directory" | "blocked" };
export type FilePage = { entries: FileEntry[]; nextCursor: string | null };
export type FileText = { text: string; revision: string; encoding: "utf-8"; bytes: number };
export type FilePreview =
	| { kind: "text"; content: FileText; rendering: "plain-text-only" }
	| { kind: "unsupported"; reason: "binary-or-encoding" };
/** This baseline represents an editor read, never a task snapshot or Git HEAD. */
export type EditorDiffBaseline = { kind: "editor-read"; target: FileTarget; revision: string; text: string };
export interface FileService {
	listRoots(workspaceId: string): Promise<FileRoot[]>;
	list(target: FileTarget, cursor?: string): Promise<FilePage>;
	readText(target: FileTarget): Promise<FileText>;
	saveText(target: FileTarget, text: string, ifMatch: string): Promise<FileText>;
	preview(target: FileTarget): Promise<FilePreview>;
}
export type FileErrorCode =
	| "INVALID_PATH"
	| "UNAUTHORIZED"
	| "NOT_FOUND"
	| "BLOCKED_RESOURCE"
	| "LIMIT_EXCEEDED"
	| "VERSION_CONFLICT"
	| "UNSUPPORTED_ENCODING"
	| "BUSY"
	| "CLOSED"
	| "IO_ERROR"
	| "WRITE_OUTCOME_UNKNOWN";
export class FileServiceError extends Error {
	readonly code: FileErrorCode;
	constructor(code: FileErrorCode) {
		super(code);
		this.name = "FileServiceError";
		this.code = code;
	}
}

/** Reject platform aliases and encoded spellings rather than decoding or normalizing them. */
export function validateRelativePath(value: unknown, allowRoot = false): string {
	if (typeof value !== "string" || value.length > 2048 || (!allowRoot && value === ""))
		throw new FileServiceError("INVALID_PATH");
	if (value === "" && allowRoot) return value;
	if (/[\\:%\x00-\x1f\x7f\ud800-\udfff]/u.test(value) || value.startsWith("/"))
		throw new FileServiceError("INVALID_PATH");
	for (const part of value.split("/")) {
		if (
			!part ||
			part.length > 255 ||
			part === "." ||
			part === ".." ||
			/[. ]$/u.test(part) ||
			/[<>"|?*]/u.test(part) ||
			/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)
		)
			throw new FileServiceError("INVALID_PATH");
	}
	return value;
}
