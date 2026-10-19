import { FileServiceError } from "@hipi/work-runtime/files";
import { type FileRequest, fileIdentifier, parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { exact, record } from "./protocol.ts";

export const FILE_CHANNEL = "hipi-work:files:v1";
export const FILE_ROOT_CHANNEL = "hipi-work:file-roots:v1";
export type RootRequest = { version: 1; expectedStoreId: string; workspaceId: string } & (
	| { operation: "pick"; writable: boolean }
	| { operation: "revoke"; rootId: string }
);
export type FileOperation =
	| { operation: "request"; request: FileRequest }
	| { operation: "check"; expectedStoreId: string; workspaceId: string }
	| { operation: "grant"; expectedStoreId: string; workspaceId: string; absolutePath: string; writable: boolean }
	| { operation: "revoke"; expectedStoreId: string; workspaceId: string; rootId: string };

export function rootRequest(raw: unknown): RootRequest {
	const value = record(raw);
	exact(value, [
		"version",
		"operation",
		"expectedStoreId",
		"workspaceId",
		...(value.operation === "pick" ? ["writable"] : ["rootId"]),
	]);
	if (value.version !== 1) throw new FileServiceError("INVALID_PATH");
	const base = {
		version: 1 as const,
		expectedStoreId: fileIdentifier(value.expectedStoreId),
		workspaceId: fileIdentifier(value.workspaceId),
	};
	if (value.operation === "pick" && typeof value.writable === "boolean")
		return { ...base, operation: "pick", writable: value.writable };
	if (value.operation === "revoke") return { ...base, operation: "revoke", rootId: fileIdentifier(value.rootId) };
	throw new FileServiceError("INVALID_PATH");
}

/** Private main-to-utility protocol. The public preload never accepts grant/path inputs. */
export function fileOperation(raw: unknown): FileOperation {
	const value = record(raw);
	if (value.operation === "request") {
		exact(value, ["operation", "request"]);
		return { operation: "request", request: parseFileRequest(value.request) };
	}
	exact(value, [
		"operation",
		"expectedStoreId",
		"workspaceId",
		...(value.operation === "grant" ? ["absolutePath", "writable"] : value.operation === "revoke" ? ["rootId"] : []),
	]);
	const base = {
		expectedStoreId: fileIdentifier(value.expectedStoreId),
		workspaceId: fileIdentifier(value.workspaceId),
	};
	if (value.operation === "check") return { ...base, operation: "check" };
	if (value.operation === "revoke") return { ...base, operation: "revoke", rootId: fileIdentifier(value.rootId) };
	if (
		value.operation === "grant" &&
		typeof value.absolutePath === "string" &&
		value.absolutePath.length <= 4096 &&
		typeof value.writable === "boolean"
	)
		return { ...base, operation: "grant", absolutePath: value.absolutePath, writable: value.writable };
	throw new FileServiceError("INVALID_PATH");
}
