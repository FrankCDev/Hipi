import { type FileRoot, FileServiceError } from "@hipi/work-runtime/files";
import { createFileClient, type FileClient, type FileRequest, parseFileRoots } from "@hipi/work-runtime/files/protocol";
export interface FileAuthority {
	chooseRoot(workspaceId: string): Promise<void>;
	revokeRoot(workspaceId: string, rootId: string): Promise<void>;
}
export interface DesktopFileBridge {
	request(raw: FileRequest): Promise<unknown>;
	manage(
		raw: { version: 1; expectedStoreId: string; workspaceId: string } & (
			| { operation: "pick"; writable: boolean }
			| { operation: "revoke"; rootId: string }
		),
	): Promise<unknown>;
}
declare global {
	interface Window {
		hipiWorkFiles?: DesktopFileBridge;
	}
}
export function desktopFiles(
	bridge: DesktopFileBridge,
	storeId: string,
): { files: FileClient; fileAuthority: FileAuthority } {
	async function manage(
		workspaceId: string,
		operation: { operation: "pick"; writable: boolean } | { operation: "revoke"; rootId: string },
	): Promise<FileRoot | null> {
		const result = await bridge.manage({ version: 1, expectedStoreId: storeId, workspaceId, ...operation });
		if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("result" in result))
			throw new FileServiceError("IO_ERROR");
		if (result.result === null) return null;
		if (operation.operation === "revoke") throw new FileServiceError("IO_ERROR");
		return parseFileRoots([result.result], workspaceId)[0] ?? null;
	}
	return {
		files: createFileClient({ storeId, request: (raw) => bridge.request(raw) }),
		fileAuthority: {
			chooseRoot: async (workspaceId) => {
				await manage(workspaceId, { operation: "pick", writable: true });
			},
			revokeRoot: async (workspaceId, rootId) => {
				await manage(workspaceId, { operation: "revoke", rootId });
			},
		},
	};
}
