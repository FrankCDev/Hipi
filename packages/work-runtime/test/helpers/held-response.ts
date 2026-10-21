import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { deterministicModels } from "../../src/testing.ts";

export const heldAnswer = "Hipi Work deterministic test answer. No model API or external tool was called.";

/** Test-owned barrier: normal PI commits the prefix, the test explicitly permits completion. */
export function heldResponse(onSettled?: () => void) {
	const models = createModels();
	const provider = deterministicModels().getProvider("faux");
	if (!provider) throw new Error("Missing deterministic provider");
	let active: { finish(complete: boolean): void } | undefined;
	models.setProvider({
		...provider,
		streamSimple(model, _context, options) {
			if (active) throw new Error("Only one held response is allowed");
			const stream = createAssistantMessageEventStream();
			let partial: AssistantMessage = {
				...fauxAssistantMessage(""),
				content: [],
				stopReason: "pending",
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			let finished = false;
			const abort = () => finish(false);
			const finish = (complete: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
				active = undefined;
				onSettled?.();
				if (complete) {
					partial = { ...partial, content: [{ type: "text", text: heldAnswer }] };
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: heldAnswer.slice("Hipi Work ".length),
						partial,
					});
					stream.push({ type: "text_end", contentIndex: 0, content: heldAnswer, partial });
					const message = {
						...fauxAssistantMessage(heldAnswer),
						api: model.api,
						provider: model.provider,
						model: model.id,
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				} else {
					const error = { ...partial, stopReason: "aborted" as const };
					stream.push({ type: "error", reason: "aborted", error });
					stream.end(error);
				}
			};
			const timer = setTimeout(abort, 10000);
			active = { finish };
			stream.push({ type: "start", partial });
			partial = { ...partial, content: [{ type: "text", text: "" }] };
			stream.push({ type: "text_start", contentIndex: 0, partial });
			partial = { ...partial, content: [{ type: "text", text: "Hipi Work " }] };
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Hipi Work ", partial });
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
			return stream;
		},
	});
	return {
		models,
		release() {
			if (!active) throw new Error("No held response to release");
			active.finish(true);
		},
		dispose() {
			active?.finish(false);
		},
	};
}
