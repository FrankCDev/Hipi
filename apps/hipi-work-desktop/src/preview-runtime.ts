import { FileServiceError } from "@hipi/work-runtime/files";
import { type PreviewRequestHandler, parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { decode, encode, exact, identifier, MAX_ACTIVE } from "./protocol.ts";

/** Cancellation belongs to the utility generation; close drains callers before cache teardown. */
export function createPreviewRuntime(handler: PreviewRequestHandler, generation: string, post: (raw: string) => void) {
	const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
	let closed = false;
	return {
		async receive(raw: unknown): Promise<boolean> {
			const value = decode(raw);
			if (value.kind !== "previewCall" && value.kind !== "previewCancel") return false;
			exact(value, ["generation", "kind", "id", ...(value.kind === "previewCall" ? ["input"] : [])]);
			if (value.generation !== generation) throw new FileServiceError("UNAUTHORIZED");
			const id = identifier(value.id);
			if (value.kind === "previewCancel") {
				active.get(id)?.controller.abort();
				return true;
			}
			if (active.has(id)) throw new FileServiceError("INVALID_PATH");
			const send = (result: object) => post(encode({ generation, kind: "previewResult", id, ...result }));
			if (closed || active.size >= MAX_ACTIVE) {
				send({ ok: false, error: closed ? "CLOSED" : "BUSY" });
				return true;
			}
			const controller = new AbortController();
			let complete = () => {};
			const done = new Promise<void>((resolve) => {
				complete = resolve;
			});
			active.set(id, { controller, done });
			try {
				const response = await handler.execute(parsePreviewRequest(value.input), controller.signal);
				if (!controller.signal.aborted) send({ ok: true, result: response });
				else if (response.ok && response.result && response.request.method === "open") {
					await handler.execute({
						version: 1,
						expectedStoreId: response.storeId,
						method: "close",
						params: { id: response.result.id },
					});
				}
			} catch (error) {
				if (!controller.signal.aborted)
					send({ ok: false, error: error instanceof FileServiceError ? error.code : "IO_ERROR" });
			} finally {
				active.delete(id);
				complete();
			}
			return true;
		},
		async close() {
			closed = true;
			const pending = [...active.values()];
			for (const entry of pending) entry.controller.abort();
			await Promise.all(pending.map((entry) => entry.done));
		},
	};
}
