import { FileServiceError } from "@hipi/work-runtime/files";
import type { FileConnection } from "./file-connection.ts";
import { rootRequest } from "./file-protocol.ts";

/** Capture both renderer lifetime and utility incarnation before showing the trusted dialog. */
export async function manageFileRoots(
	raw: unknown,
	connection: () => FileConnection,
	owned: () => boolean,
	pick: (writable: boolean) => Promise<string | null>,
): Promise<unknown> {
	if (!owned()) throw new FileServiceError("UNAUTHORIZED");
	const request = rootRequest(raw);
	const current = connection();
	const base = { expectedStoreId: request.expectedStoreId, workspaceId: request.workspaceId };
	if (request.operation === "revoke") return current.call({ ...base, operation: "revoke", rootId: request.rootId });
	await current.call({ ...base, operation: "check" });
	if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
	const absolutePath = await pick(request.writable);
	if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
	if (absolutePath === null) return null;
	return current.call({ ...base, operation: "grant", absolutePath, writable: request.writable });
}
