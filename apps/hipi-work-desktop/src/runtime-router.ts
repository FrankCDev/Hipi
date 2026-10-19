import type { WorkRuntime } from "@hipi/work-runtime";
import { AppError, PROTOCOL_VERSION, parseFrame, parseResult, type Subscription } from "@hipi/work-runtime/contracts";
import { command, encode, MAX_ACTIVE, WAIT_MS } from "./protocol.ts";
import { diagnoseRuntimeOperation, type RuntimeDiagnostic } from "./runtime-diagnostics.ts";

type Active = { controller: AbortController; ack?: () => void; subscription?: Subscription };
/** One trusted host connection. Cancel releases observation/wait only, never accepted execution. */
export function createRuntimeRouter(
	runtime: Pick<WorkRuntime, "execute" | "observe" | "close">,
	generation: string,
	post: (raw: string) => void,
	beforeClose: () => Promise<void> = async () => {},
	report: (diagnostic: RuntimeDiagnostic) => void = () => {},
) {
	const active = new Map<string, Active>();
	let closing: Promise<void> | undefined;
	const send = (value: object) => post(encode({ generation, ...value }));
	const release = async (entry: Active) => {
		entry.controller.abort();
		entry.ack?.();
		await entry.subscription?.dispose();
	};
	const shutdown = () => {
		closing ??= (async () => {
			await diagnoseRuntimeOperation(beforeClose, { category: "close", phase: "file-services-close" }, report);
			await diagnoseRuntimeOperation(
				() => Promise.all([...active.values()].map(release)),
				{ category: "close", phase: "subscriptions-close" },
				report,
			);
			await diagnoseRuntimeOperation(() => runtime.close(), { category: "close", phase: "runtime-close" }, report);
			active.clear();
		})();
		return closing;
	};
	async function receive(raw: unknown): Promise<void> {
		const message = command(raw);
		if (message.generation !== generation) throw new AppError("UNAUTHORIZED");
		if (message.kind === "shutdown") {
			await shutdown();
			send({ kind: "stopped" });
			return;
		}
		const { id } = message;
		if (message.kind === "cancel") {
			const entry = active.get(id);
			if (entry) await release(entry);
			return;
		}
		if (message.kind === "ack") {
			active.get(id)?.ack?.();
			return;
		}
		if (closing) {
			send({ kind: "error", id, error: "CLOSED" });
			return;
		}
		if (active.has(id)) throw new AppError("INVALID_REQUEST");
		if (active.size >= MAX_ACTIVE) {
			send({ kind: "error", id, error: "CAPACITY_EXCEEDED" });
			return;
		}
		const entry: Active = { controller: new AbortController() };
		active.set(id, entry);
		try {
			if (message.kind === "call") {
				const result = parseResult(message.request.method, await runtime.execute(message.request));
				if (!entry.controller.signal.aborted) send({ kind: "result", id, result });
			} else if (message.kind === "observe") {
				await runtime.execute({
					version: PROTOCOL_VERSION,
					method: "snapshot",
					params: message.input.scope,
					expectedStoreId: message.input.expectedStoreId,
				});
				if (entry.controller.signal.aborted) return;
				entry.subscription = await runtime.observe(
					message.input.scope,
					async (frame) => {
						if (entry.controller.signal.aborted) return;
						if (entry.ack) throw new AppError("CAPACITY_EXCEEDED");
						// At most one unacknowledged snapshot crosses each transport; upstream coalesces newer snapshots.
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								entry.ack = undefined;
								reject(new AppError("CLOSED"));
							}, WAIT_MS);
							entry.ack = () => {
								clearTimeout(timer);
								entry.ack = undefined;
								resolve();
							};
							try {
								send({ kind: "frame", id, frame: parseFrame(frame) });
							} catch (error) {
								clearTimeout(timer);
								entry.ack = undefined;
								reject(error);
							}
						});
					},
					entry.controller.signal,
					(status) => {
						if (entry.controller.signal.aborted || status.state !== "closed") return;
						entry.controller.abort();
						entry.ack?.();
						send({
							kind: "status",
							id,
							status: { ...status, reason: status.reason === "disposed" ? "disconnected" : status.reason },
						});
					},
				);
				if (!entry.controller.signal.aborted)
					await new Promise<void>((resolve) =>
						entry.controller.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
			}
		} catch (error) {
			if (!entry.controller.signal.aborted)
				send({ kind: "error", id, error: error instanceof AppError ? error.code : "INTERNAL" });
		} finally {
			await release(entry);
			active.delete(id);
		}
	}
	return { receive, shutdown, activeCount: () => active.size };
}
