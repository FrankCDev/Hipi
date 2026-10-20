import {
	type FileRoot,
	FileServiceError,
	type ProjectFolder,
	type ProjectFolderSelection,
} from "@hipi/work-runtime/files";
import {
	createFileClient,
	type FileClient,
	type FileRequest,
	parseFileRoots,
	parseProjectFolder,
	parseProjectFolderSelection,
} from "@hipi/work-runtime/files/protocol";

export type { ProjectFolderSelection } from "@hipi/work-runtime/files";
export interface FileAuthority {
	chooseRoot(workspaceId: string): Promise<void>;
	revokeRoot(workspaceId: string, rootId: string): Promise<void>;
	/** Local host capability only. A binding is not model-context or write permission. */
	getProject?(workspaceId: string): Promise<ProjectFolder>;
	chooseProject?(
		workspaceId: string,
		expectedBindingId: string | null,
		locale?: "en" | "zh-CN",
	): Promise<ProjectFolder | null>;
	unbindProject?(workspaceId: string, expectedBindingId: string): Promise<ProjectFolder>;
	prepareProject?(locale?: "en" | "zh-CN"): Promise<ProjectFolderSelection | null>;
	attachProject?(workspaceId: string, selectionId: string): Promise<ProjectFolder>;
	forgetProjectSelection?(selectionId: string): Promise<void>;
}
export interface DesktopFileBridge {
	request(raw: FileRequest): Promise<unknown>;
	manage(
		raw: { version: 1; expectedStoreId: string } & (
			| { operation: "pick"; workspaceId: string; writable: boolean }
			| { operation: "revoke"; workspaceId: string; rootId: string }
			| { operation: "project-get"; workspaceId: string }
			| { operation: "project-pick"; workspaceId: string; expectedBindingId: string | null; locale?: "en" | "zh-CN" }
			| { operation: "project-unbind"; workspaceId: string; expectedBindingId: string }
			| { operation: "project-prepare"; locale?: "en" | "zh-CN" }
			| { operation: "project-attach"; workspaceId: string; selectionId: string }
			| { operation: "project-forget"; selectionId: string }
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
	async function project(
		workspaceId: string,
		operation:
			| { operation: "project-get" }
			| { operation: "project-pick"; expectedBindingId: string | null; locale?: "en" | "zh-CN" }
			| { operation: "project-unbind"; expectedBindingId: string }
			| { operation: "project-attach"; selectionId: string },
	): Promise<ProjectFolder | null> {
		const result = await bridge.manage({ version: 1, expectedStoreId: storeId, workspaceId, ...operation });
		if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("result" in result))
			throw new FileServiceError("IO_ERROR");
		if (result.result === null && operation.operation === "project-pick") return null;
		return parseProjectFolder(result.result, workspaceId);
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
			getProject: async (workspaceId) => {
				const result = await project(workspaceId, { operation: "project-get" });
				if (!result) throw new FileServiceError("IO_ERROR");
				return result;
			},
			chooseProject: (workspaceId, expectedBindingId, locale) =>
				project(workspaceId, { operation: "project-pick", expectedBindingId, ...(locale ? { locale } : {}) }),
			unbindProject: async (workspaceId, expectedBindingId) => {
				const result = await project(workspaceId, { operation: "project-unbind", expectedBindingId });
				if (!result) throw new FileServiceError("IO_ERROR");
				return result;
			},
			prepareProject: async (locale) => {
				const result = await bridge.manage({
					version: 1,
					expectedStoreId: storeId,
					operation: "project-prepare",
					...(locale ? { locale } : {}),
				});
				if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("result" in result))
					throw new FileServiceError("IO_ERROR");
				return result.result === null ? null : parseProjectFolderSelection(result.result);
			},
			attachProject: async (workspaceId, selectionId) => {
				const result = await project(workspaceId, { operation: "project-attach", selectionId });
				if (!result) throw new FileServiceError("IO_ERROR");
				return result;
			},
			forgetProjectSelection: async (selectionId) => {
				const result = await bridge.manage({
					version: 1,
					expectedStoreId: storeId,
					operation: "project-forget",
					selectionId,
				});
				if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
					throw new FileServiceError("IO_ERROR");
			},
		},
	};
}
