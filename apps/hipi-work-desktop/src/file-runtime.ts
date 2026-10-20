import type { AppClient } from "@hipi/work-runtime/contracts";
import { FileServiceError } from "@hipi/work-runtime/files";
import { createRuntimeFileHost } from "@hipi/work-runtime/files/host";
import { createRuntimeProjectFolders } from "@hipi/work-runtime/node";
import { createRuntimePreviewHost } from "@hipi/work-runtime/previews/host";
import { fileOperation } from "./file-protocol.ts";
import { createPreviewRuntime } from "./preview-runtime.ts";
import { decode, encode, exact, identifier, MAX_ACTIVE } from "./protocol.ts";

/** Grants belong to this utility incarnation only; catalog reads never open a workspace. */
export async function createFileRuntime(
	runtime: AppClient,
	generation: string,
	post: (raw: string) => void,
	options: { workerUrl?: URL } = {},
) {
	const { authority, handler, storeId } = await createRuntimeFileHost(runtime, generation);
	const projects = createRuntimeProjectFolders(runtime, authority, generation);
	const previewHost = createRuntimePreviewHost({ authority, principalId: generation, storeId, ...options });
	const previews = createPreviewRuntime(previewHost.handler, generation, post);
	async function check(expectedStoreId: string, workspaceId: string) {
		const result = await handler.execute({ version: 1, method: "listRoots", expectedStoreId, params: { workspaceId } });
		if (!result.ok) throw new FileServiceError(result.error);
	}
	const service = authority.forPrincipal(generation);
	const active = new Set<string>();
	let closed = false;
	return {
		// Trusted utility composition only; never exposed through the public bridge.
		agentFiles: authority.forAgent(generation),
		async receive(raw: unknown): Promise<boolean> {
			if (await previews.receive(raw)) return true;
			const value = decode(raw);
			if (value.kind !== "fileCall") return false;
			exact(value, ["generation", "kind", "id", "input"]);
			if (value.generation !== generation) throw new FileServiceError("UNAUTHORIZED");
			const id = identifier(value.id);
			if (active.has(id)) throw new FileServiceError("INVALID_PATH");
			const send = (result: object) => post(encode({ generation, kind: "fileResult", id, ...result }));
			if (closed || active.size >= MAX_ACTIVE) {
				send({ ok: false, error: closed ? "CLOSED" : "BUSY" });
				return true;
			}
			active.add(id);
			try {
				const input = fileOperation(value.input);
				let result: unknown;
				if (input.operation === "request") result = await handler.execute(input.request);
				else if (
					input.operation === "project-store-check" ||
					input.operation === "project-prepare" ||
					input.operation === "project-forget"
				) {
					if (input.expectedStoreId !== storeId) throw new FileServiceError("UNAUTHORIZED");
					if (closed) throw new FileServiceError("CLOSED");
					if (!projects) throw new FileServiceError("BLOCKED_RESOURCE");
					if (input.operation === "project-prepare") result = await projects.prepare(input.absolutePath);
					else {
						if (input.operation === "project-forget") projects.forget(input.selectionId);
						result = null;
					}
				} else {
					await check(input.expectedStoreId, input.workspaceId);
					if (closed) throw new FileServiceError("CLOSED");
					if (
						input.operation === "project-get" ||
						input.operation === "project-bind" ||
						input.operation === "project-unbind" ||
						input.operation === "project-attach"
					) {
						if (!projects) throw new FileServiceError("BLOCKED_RESOURCE");
						result =
							input.operation === "project-get"
								? await projects.get(input.workspaceId)
								: input.operation === "project-bind"
									? await projects.bind(input.workspaceId, input.absolutePath, input.expectedBindingId)
									: input.operation === "project-attach"
										? await projects.attach(input.workspaceId, input.selectionId)
										: await projects.unbind(input.workspaceId, input.expectedBindingId);
					} else if (input.operation === "grant")
						result = await authority.grantRoot({
							principalId: generation,
							workspaceId: input.workspaceId,
							absolutePath: input.absolutePath,
							writable: input.writable,
						});
					else if (input.operation === "revoke") {
						const roots = await service.listRoots(input.workspaceId);
						if (!roots.some((root) => root.rootId === input.rootId)) throw new FileServiceError("UNAUTHORIZED");
						if (!projects?.revokeRoot(input.workspaceId, input.rootId)) authority.revokeRoot(input.rootId);
						result = null;
					} else result = null;
				}
				send({ ok: true, result });
			} catch (error) {
				send({ ok: false, error: error instanceof FileServiceError ? error.code : "IO_ERROR" });
			} finally {
				active.delete(id);
			}
			return true;
		},
		async close() {
			closed = true;
			await projects?.close();
			await previews.close();
			await previewHost.close();
			await authority.close();
		},
	};
}
