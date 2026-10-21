import { FileServiceError } from "@hipi/work-runtime/files";
import { parseProjectFolderSelection } from "@hipi/work-runtime/files/protocol";
import type { FileConnection } from "./connection.ts";
import { rootRequest } from "./protocol.ts";

/** Main-process ownership fence. A token never survives renderer teardown or a utility replacement. */
export class ProjectFolderSelections {
	readonly #selections = new Map<string, { connection: FileConnection; expectedStoreId: string; expires: number }>();
	add(selectionId: string, connection: FileConnection, expectedStoreId: string): void {
		for (const [id, entry] of this.#selections)
			if (entry.expires <= Date.now() || entry.connection !== connection) this.#selections.delete(id);
		if (this.#selections.size >= 8) throw new FileServiceError("LIMIT_EXCEEDED");
		this.#selections.set(selectionId, { connection, expectedStoreId, expires: Date.now() + 15 * 60_000 });
	}
	take(selectionId: string, connection: FileConnection, expectedStoreId: string): void {
		const entry = this.#selections.get(selectionId);
		if (entry && (entry.connection !== connection || entry.expires <= Date.now())) this.#selections.delete(selectionId);
		if (
			!entry ||
			entry.connection !== connection ||
			entry.expectedStoreId !== expectedStoreId ||
			entry.expires <= Date.now()
		)
			throw new FileServiceError("UNAUTHORIZED");
		this.#selections.delete(selectionId);
	}
	clear(): void {
		for (const [selectionId, entry] of this.#selections) {
			void entry.connection
				.call({ operation: "project-forget", expectedStoreId: entry.expectedStoreId, selectionId })
				.catch(() => undefined);
		}
		this.#selections.clear();
	}
}

/** Capture both renderer lifetime and utility incarnation before showing the trusted dialog. */
export async function manageFileRoots(
	raw: unknown,
	connection: () => FileConnection,
	owned: () => boolean,
	pick: (writable: boolean, project?: boolean, locale?: "en" | "zh-CN") => Promise<string | null>,
	selections?: ProjectFolderSelections,
): Promise<unknown> {
	if (!owned()) throw new FileServiceError("UNAUTHORIZED");
	const request = rootRequest(raw);
	const current = connection();
	if (request.operation === "project-forget" || request.operation === "project-attach") {
		if (!selections) throw new FileServiceError("UNAUTHORIZED");
		selections.take(request.selectionId, current, request.expectedStoreId);
		try {
			return await current.call(
				request.operation === "project-forget"
					? { operation: "project-forget", expectedStoreId: request.expectedStoreId, selectionId: request.selectionId }
					: {
							operation: "project-attach",
							expectedStoreId: request.expectedStoreId,
							workspaceId: request.workspaceId,
							selectionId: request.selectionId,
						},
			);
		} catch (error) {
			if (request.operation === "project-attach")
				await current
					.call({
						operation: "project-forget",
						expectedStoreId: request.expectedStoreId,
						selectionId: request.selectionId,
					})
					.catch(() => undefined);
			throw error;
		}
	}
	if (request.operation === "project-prepare") {
		if (!selections) throw new FileServiceError("UNAUTHORIZED");
		await current.call({ operation: "project-store-check", expectedStoreId: request.expectedStoreId });
		if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
		const absolutePath = await pick(false, true, request.locale ?? "en");
		if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
		if (absolutePath === null) return null;
		const selection = parseProjectFolderSelection(
			await current.call({ operation: "project-prepare", expectedStoreId: request.expectedStoreId, absolutePath }),
		);
		try {
			if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
			selections.add(selection.selectionId, current, request.expectedStoreId);
			return selection;
		} catch (error) {
			await current
				.call({
					operation: "project-forget",
					expectedStoreId: request.expectedStoreId,
					selectionId: selection.selectionId,
				})
				.catch(() => undefined);
			throw error;
		}
	}
	const base = { expectedStoreId: request.expectedStoreId, workspaceId: request.workspaceId };
	if (request.operation === "revoke") return current.call({ ...base, operation: "revoke", rootId: request.rootId });
	if (request.operation === "project-get") return current.call({ ...base, operation: "project-get" });
	if (request.operation === "project-unbind")
		return current.call({ ...base, operation: "project-unbind", expectedBindingId: request.expectedBindingId });
	await current.call({ ...base, operation: "check" });
	if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
	const absolutePath = await pick(
		request.operation === "pick" && request.writable,
		request.operation === "project-pick",
		request.operation === "project-pick" ? (request.locale ?? "en") : undefined,
	);
	if (!owned() || connection() !== current) throw new FileServiceError("CLOSED");
	if (absolutePath === null) return null;
	if (request.operation === "project-pick")
		return current.call({
			...base,
			operation: "project-bind",
			absolutePath,
			expectedBindingId: request.expectedBindingId,
		});
	return current.call({ ...base, operation: "grant", absolutePath, writable: request.writable });
}
