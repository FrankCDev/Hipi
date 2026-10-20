import { type FileErrorCode, FileServiceError } from "@hipi/work-runtime/files";
import {
	parseFileResponse,
	parseFileRoots,
	parseProjectFolder,
	parseProjectFolderSelection,
} from "@hipi/work-runtime/files/protocol";
import { type FileOperation, fileOperation } from "./file-protocol.ts";
import { decode, encode, exact, identifier, MAX_ACTIVE, WAIT_MS } from "./protocol.ts";

const codes: FileErrorCode[] = [
	"INVALID_PATH",
	"UNAUTHORIZED",
	"NOT_FOUND",
	"BLOCKED_RESOURCE",
	"LIMIT_EXCEEDED",
	"VERSION_CONFLICT",
	"UNSUPPORTED_ENCODING",
	"BUSY",
	"CLOSED",
	"IO_ERROR",
	"WRITE_OUTCOME_UNKNOWN",
];
/** Main's private utility endpoint. A lost save reply is never safe to replay. */
export class FileConnection {
	readonly #generation: string;
	readonly #post: (raw: string) => void;
	readonly #pending = new Map<
		string,
		{
			input: FileOperation;
			resolve(value: unknown): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	#next = 0;
	#closed = false;
	constructor(generation: string, post: (raw: string) => void) {
		this.#generation = generation;
		this.#post = post;
	}
	call(raw: FileOperation): Promise<unknown> {
		const input = fileOperation(raw);
		if (this.#closed) return Promise.reject(new FileServiceError("CLOSED"));
		if (this.#pending.size >= MAX_ACTIVE) return Promise.reject(new FileServiceError("BUSY"));
		const id = String(++this.#next);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new FileServiceError(
						input.operation === "request" && input.request.method === "saveText" ? "WRITE_OUTCOME_UNKNOWN" : "CLOSED",
					),
				);
			}, WAIT_MS);
			this.#pending.set(id, { input, resolve, reject, timer });
			try {
				this.#post(encode({ generation: this.#generation, kind: "fileCall", id, input }));
			} catch {
				this.close();
			}
		});
	}
	receive(raw: unknown): boolean {
		const value = decode(raw);
		if (value.kind !== "fileResult") return false;
		if (value.generation !== this.#generation) return true;
		exact(value, ["generation", "kind", "id", "ok", ...(value.ok === true ? ["result"] : ["error"])]);
		const id = identifier(value.id);
		const pending = this.#pending.get(id);
		if (!pending) return true;
		let result: unknown;
		let error: FileServiceError | undefined;
		if (value.ok === false) {
			const code = codes.find((code) => code === value.error);
			if (!code) throw new FileServiceError("INVALID_PATH");
			error = new FileServiceError(code);
		} else if (value.ok === true) {
			if (pending.input.operation === "request") result = parseFileResponse(value.result, pending.input.request);
			else if (pending.input.operation === "grant")
				result = parseFileRoots([value.result], pending.input.workspaceId)[0];
			else if (
				pending.input.operation === "project-get" ||
				pending.input.operation === "project-bind" ||
				pending.input.operation === "project-unbind" ||
				pending.input.operation === "project-attach"
			) {
				const folder = parseProjectFolder(value.result, pending.input.workspaceId);
				if (
					(pending.input.operation === "project-unbind" &&
						(folder.status !== "revoked" || folder.bindingId !== pending.input.expectedBindingId)) ||
					((pending.input.operation === "project-bind" || pending.input.operation === "project-attach") &&
						folder.status !== "available")
				)
					throw new FileServiceError("INVALID_PATH");
				result = folder;
			} else if (pending.input.operation === "project-prepare") result = parseProjectFolderSelection(value.result);
			else if (value.result !== null) throw new FileServiceError("INVALID_PATH");
			else result = null;
		} else throw new FileServiceError("INVALID_PATH");
		clearTimeout(pending.timer);
		this.#pending.delete(id);
		if (error) pending.reject(error);
		else pending.resolve(result);
		return true;
	}
	close() {
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				new FileServiceError(
					pending.input.operation === "request" && pending.input.request.method === "saveText"
						? "WRITE_OUTCOME_UNKNOWN"
						: "CLOSED",
				),
			);
		}
		this.#pending.clear();
	}
}
