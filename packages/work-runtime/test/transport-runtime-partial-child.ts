import { createAssistantMessageEventStream, createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openRuntime } from "../src/node.ts";
import { deterministicModels } from "../src/testing.ts";
import { serveNodeIpc } from "../src/transport-ipc.ts";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("A test directory and inherited IPC channel are required");
const models = createModels();
const provider = deterministicModels().getProvider("faux");
if (!provider) throw new Error("Missing deterministic provider");
models.setProvider({
	...provider,
	streamSimple(model, _context, options) {
		// Hold the response open, rather than racing a token-rate-dependent completion against SIGKILL.
		// PI's normal progress timer must commit this prefix; the parent independently reads that commit.
		const stream = createAssistantMessageEventStream();
		const partial = {
			...fauxAssistantMessage("Hipi Work "),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Hipi Work ", partial });
		const abort = () => {
			const error = { ...partial, stopReason: "aborted" as const };
			stream.push({ type: "error", reason: "aborted", error });
			stream.end(error);
		};
		if (options?.signal?.aborted) abort();
		else options?.signal?.addEventListener("abort", abort, { once: true });
		return stream;
	},
});
const runtime = await openRuntime(directory, { models, model: { provider: "faux", modelId: "faux-1" }, resume: true });
const stop = serveNodeIpc(runtime);
process.send("ready");
process.once("disconnect", () => {
	stop();
	void runtime.close().catch(() => {
		process.exitCode = 1;
	});
});
