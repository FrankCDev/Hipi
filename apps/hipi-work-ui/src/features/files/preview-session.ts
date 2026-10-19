import { FileServiceError, type FileTarget } from "@hipi/work-runtime/files";
import {
	PREVIEW_LIMITS,
	type PreviewClient,
	type PreviewHandle,
	type PreviewPage,
} from "@hipi/work-runtime/previews/protocol";
import { PREVIEW_HANDLERS } from "./preview-registry.ts";

export const PREVIEW_BYTE_LIMIT = PREVIEW_HANDLERS.pdf.maxBytes;
export type PreviewSnapshot = {
	target?: FileTarget;
	handle?: PreviewHandle;
	page?: PreviewPage;
	bytes?: Uint8Array<ArrayBuffer>;
	loading?: boolean;
	error?: string;
};

/** Owns one authorized handle and one page/binary buffer; stale replies never publish. */
export class PreviewSession {
	private state: PreviewSnapshot = {};
	private listeners = new Set<() => void>();
	private generation = 0;
	private pending?: AbortController;
	private handle?: PreviewHandle;
	private client: PreviewClient;
	constructor(client: PreviewClient) {
		this.client = client;
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(state: PreviewSnapshot) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	private release(handle: PreviewHandle) {
		// Transport failure cannot retain UI resources; the service additionally expires handles.
		void this.client.close(handle.id).catch(() => {});
	}
	clear() {
		this.generation++;
		this.pending?.abort();
		this.pending = undefined;
		if (this.handle) this.release(this.handle);
		this.handle = undefined;
		this.publish({});
	}
	fail(code = "BLOCKED_RESOURCE") {
		const target = this.state.target;
		this.clear();
		this.publish({ target, error: code });
	}
	async open(target: FileTarget) {
		this.clear();
		const generation = this.generation;
		const controller = new AbortController();
		this.pending = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
		this.publish({ target, loading: true });
		try {
			const handle = await this.client.open(target, signal);
			if (generation !== this.generation || signal.aborted) {
				this.release(handle);
				if (generation === this.generation) this.fail("CLOSED");
				return;
			}
			this.handle = handle;
			const handler = PREVIEW_HANDLERS[handle.kind];
			if (handler.source === "pages") {
				if (handle.summary.pages < 1) throw new FileServiceError("BLOCKED_RESOURCE");
				this.publish({ target, handle });
				await this.readPage(0);
				return;
			}
			if (handle.summary.bytes <= 0 || handle.summary.bytes > handler.maxBytes)
				throw new FileServiceError("LIMIT_EXCEEDED");
			const bytes = new Uint8Array(handle.summary.bytes);
			for (let offset = 0; offset < bytes.length; offset += PREVIEW_LIMITS.chunkBytes) {
				const chunk = await this.client.readBytes(handle.id, offset, signal);
				if (generation !== this.generation) return;
				if (signal.aborted) throw new FileServiceError("CLOSED");
				if (
					chunk.id !== handle.id ||
					chunk.revision !== handle.revision ||
					chunk.offset !== offset ||
					chunk.total !== bytes.length
				)
					throw new FileServiceError("BLOCKED_RESOURCE");
				const decoded = atob(chunk.base64);
				if (decoded.length !== Math.min(PREVIEW_LIMITS.chunkBytes, bytes.length - offset))
					throw new FileServiceError("BLOCKED_RESOURCE");
				for (let index = 0; index < decoded.length; index++) bytes[offset + index] = decoded.charCodeAt(index);
			}
			if (generation === this.generation) this.publish({ target, handle, bytes });
		} catch (error) {
			if (generation === this.generation) this.fail(error instanceof FileServiceError ? error.code : "IO_ERROR");
		}
	}
	async readPage(page: number) {
		const handle = this.handle;
		if (!handle || !Number.isInteger(page) || page < 0 || page >= handle.summary.pages) return;
		this.pending?.abort();
		const controller = new AbortController();
		this.pending = controller;
		const generation = ++this.generation;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
		const target = this.state.target;
		this.publish({ target, handle, loading: true });
		try {
			const result = await this.client.readPage(handle.id, page, signal);
			if (generation !== this.generation) return;
			if (signal.aborted) throw new FileServiceError("CLOSED");
			if (
				result.id !== handle.id ||
				result.revision !== handle.revision ||
				result.page !== page ||
				result.content.format !== handle.kind
			)
				throw new FileServiceError("BLOCKED_RESOURCE");
			this.publish({ target, handle, page: result });
		} catch (error) {
			if (generation === this.generation) this.fail(error instanceof FileServiceError ? error.code : "IO_ERROR");
		}
	}
	dispose() {
		this.clear();
		this.listeners.clear();
	}
}
