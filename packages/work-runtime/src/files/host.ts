import { isAbsolute } from "node:path";
import type { AppClient } from "../contracts.ts";
import { FileServiceError } from "./contracts.ts";
import { createFileRequestHandler, fileIdentifier } from "./protocol.ts";
import { createFileAuthority } from "./service.ts";

/** Trusted CLI input only; never expose absolutePath over the public protocol. */
export function parseHostFileMapping(raw: string): { workspaceId: string; absolutePath: string; writable: boolean } {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		const v = value as Record<string, unknown>;
		if (
			Object.keys(v).some((key) => !["workspaceId", "absolutePath", "writable"].includes(key)) ||
			typeof v.absolutePath !== "string" ||
			!isAbsolute(v.absolutePath) ||
			typeof v.writable !== "boolean"
		)
			throw new Error();
		return { workspaceId: fileIdentifier(v.workspaceId), absolutePath: v.absolutePath, writable: v.writable };
	} catch {
		throw new FileServiceError("INVALID_PATH");
	}
}
/** One authority per runtime generation; catalog lookup never opens or resumes workspaces. */
export async function createRuntimeFileHost(runtime: AppClient, principalId: string) {
	fileIdentifier(principalId);
	const identity = await runtime.call("handshake", {});
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		async assertWorkspaceAccess(principal, workspaceId) {
			if (principal !== principalId) throw new FileServiceError("UNAUTHORIZED");
			try {
				const workspace = await runtime.call("getWorkspace", { workspaceId });
				if (workspace.workspaceId !== workspaceId) throw new FileServiceError("UNAUTHORIZED");
			} catch {
				throw new FileServiceError("UNAUTHORIZED");
			}
		},
	});
	return {
		authority,
		handler: createFileRequestHandler(authority.forPrincipal(principalId), identity.storeId),
		storeId: identity.storeId,
	};
}
