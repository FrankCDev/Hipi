import { FileServiceError } from "@hipi/work-runtime/files";
import { type FileRequest, fileIdentifier, parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { exact, record } from "./protocol.ts";

export const FILE_CHANNEL = "hipi-work:files:v1";
export const FILE_ROOT_CHANNEL = "hipi-work:file-roots:v1";
export type RootRequest = { version: 1; expectedStoreId: string } & (
	| { workspaceId: string; operation: "pick"; writable: boolean }
	| { workspaceId: string; operation: "revoke"; rootId: string }
	| { workspaceId: string; operation: "project-get" }
	| { workspaceId: string; operation: "project-pick"; expectedBindingId: string | null; locale?: "en" | "zh-CN" }
	| { workspaceId: string; operation: "project-unbind"; expectedBindingId: string }
	| { workspaceId: string; operation: "project-attach"; selectionId: string }
	| { operation: "project-prepare"; locale?: "en" | "zh-CN" }
	| { operation: "project-forget"; selectionId: string }
);
export type FileOperation =
	| { operation: "request"; request: FileRequest }
	| { operation: "check"; expectedStoreId: string; workspaceId: string }
	| { operation: "grant"; expectedStoreId: string; workspaceId: string; absolutePath: string; writable: boolean }
	| { operation: "revoke"; expectedStoreId: string; workspaceId: string; rootId: string }
	| { operation: "project-get"; expectedStoreId: string; workspaceId: string }
	| {
			operation: "project-bind";
			expectedStoreId: string;
			workspaceId: string;
			absolutePath: string;
			expectedBindingId: string | null;
	  }
	| { operation: "project-unbind"; expectedStoreId: string; workspaceId: string; expectedBindingId: string }
	| { operation: "project-store-check"; expectedStoreId: string }
	| { operation: "project-prepare"; expectedStoreId: string; absolutePath: string }
	| { operation: "project-attach"; expectedStoreId: string; workspaceId: string; selectionId: string }
	| { operation: "project-forget"; expectedStoreId: string; selectionId: string };

export function rootRequest(raw: unknown): RootRequest {
	const value = record(raw);
	if (value.version !== 1) throw new FileServiceError("INVALID_PATH");
	if (
		(value.operation === "project-prepare" || value.operation === "project-pick") &&
		value.locale !== undefined &&
		value.locale !== "en" &&
		value.locale !== "zh-CN"
	)
		throw new FileServiceError("INVALID_PATH");
	if (value.operation === "project-prepare" || value.operation === "project-forget") {
		exact(value, [
			"version",
			"operation",
			"expectedStoreId",
			...(value.operation === "project-forget" ? ["selectionId"] : ["locale"]),
		]);
		const base = { version: 1 as const, expectedStoreId: fileIdentifier(value.expectedStoreId) };
		return value.operation === "project-prepare"
			? { ...base, operation: "project-prepare", locale: value.locale === "zh-CN" ? "zh-CN" : "en" }
			: { ...base, operation: "project-forget", selectionId: fileIdentifier(value.selectionId) };
	}
	exact(value, [
		"version",
		"operation",
		"expectedStoreId",
		"workspaceId",
		...(value.operation === "project-pick" ? ["locale"] : []),
		...(value.operation === "pick"
			? ["writable"]
			: value.operation === "revoke"
				? ["rootId"]
				: value.operation === "project-get"
					? []
					: value.operation === "project-attach"
						? ["selectionId"]
						: ["expectedBindingId"]),
	]);
	const base = {
		version: 1 as const,
		expectedStoreId: fileIdentifier(value.expectedStoreId),
		workspaceId: fileIdentifier(value.workspaceId),
	};
	if (value.operation === "pick" && typeof value.writable === "boolean")
		return { ...base, operation: "pick", writable: value.writable };
	if (value.operation === "revoke") return { ...base, operation: "revoke", rootId: fileIdentifier(value.rootId) };
	if (value.operation === "project-get") return { ...base, operation: "project-get" };
	if (value.operation === "project-attach")
		return { ...base, operation: "project-attach", selectionId: fileIdentifier(value.selectionId) };
	if (value.operation === "project-pick")
		return {
			...base,
			operation: "project-pick",
			expectedBindingId: value.expectedBindingId === null ? null : fileIdentifier(value.expectedBindingId),
			locale: value.locale === "zh-CN" ? "zh-CN" : "en",
		};
	if (value.operation === "project-unbind")
		return {
			...base,
			operation: "project-unbind",
			expectedBindingId: fileIdentifier(value.expectedBindingId),
		};
	throw new FileServiceError("INVALID_PATH");
}

/** Private main-to-utility protocol. The public preload never accepts grant/path inputs. */
export function fileOperation(raw: unknown): FileOperation {
	const value = record(raw);
	if (value.operation === "request") {
		exact(value, ["operation", "request"]);
		return { operation: "request", request: parseFileRequest(value.request) };
	}
	if (
		value.operation === "project-store-check" ||
		value.operation === "project-prepare" ||
		value.operation === "project-forget"
	) {
		exact(value, [
			"operation",
			"expectedStoreId",
			...(value.operation === "project-prepare"
				? ["absolutePath"]
				: value.operation === "project-forget"
					? ["selectionId"]
					: []),
		]);
		const base = { expectedStoreId: fileIdentifier(value.expectedStoreId) };
		if (value.operation === "project-store-check") return { ...base, operation: "project-store-check" };
		if (value.operation === "project-forget")
			return { ...base, operation: "project-forget", selectionId: fileIdentifier(value.selectionId) };
		if (typeof value.absolutePath !== "string" || value.absolutePath.length > 4096)
			throw new FileServiceError("INVALID_PATH");
		return { ...base, operation: "project-prepare", absolutePath: value.absolutePath };
	}
	exact(value, [
		"operation",
		"expectedStoreId",
		"workspaceId",
		...(value.operation === "grant"
			? ["absolutePath", "writable"]
			: value.operation === "revoke"
				? ["rootId"]
				: value.operation === "project-bind"
					? ["absolutePath", "expectedBindingId"]
					: value.operation === "project-unbind"
						? ["expectedBindingId"]
						: value.operation === "project-attach"
							? ["selectionId"]
							: []),
	]);
	const base = {
		expectedStoreId: fileIdentifier(value.expectedStoreId),
		workspaceId: fileIdentifier(value.workspaceId),
	};
	if (value.operation === "check") return { ...base, operation: "check" };
	if (value.operation === "project-get") return { ...base, operation: "project-get" };
	if (value.operation === "project-attach")
		return { ...base, operation: "project-attach", selectionId: fileIdentifier(value.selectionId) };
	if (value.operation === "project-unbind")
		return {
			...base,
			operation: "project-unbind",
			expectedBindingId: fileIdentifier(value.expectedBindingId),
		};
	if (value.operation === "project-bind" && typeof value.absolutePath === "string" && value.absolutePath.length <= 4096)
		return {
			...base,
			operation: "project-bind",
			absolutePath: value.absolutePath,
			expectedBindingId: value.expectedBindingId === null ? null : fileIdentifier(value.expectedBindingId),
		};
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
