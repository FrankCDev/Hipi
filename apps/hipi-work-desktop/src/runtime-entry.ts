import type { TrustedAgentFileService } from "@hipi/work-runtime/files/node";
import { createProductionModels } from "@hipi/work-runtime/model-provider";
import { openRuntime } from "@hipi/work-runtime/node";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { CredentialRpc } from "./credential-rpc.ts";
import { createFileRuntime } from "./file-runtime.ts";
import { encode, identifier } from "./protocol.ts";
import { createRuntimeRouter } from "./runtime-router.ts";

const [directory, rawGeneration, provider] = process.argv.slice(2);
if (!directory || (provider !== "deterministic" && provider !== "production"))
	throw new Error("Explicit provider mode is required");
const generation = identifier(rawGeneration);
const parent = process.parentPort;
if (!parent) throw new Error("Electron utility parentPort is required");
const credentials = new CredentialRpc(generation, (raw) => parent.postMessage(raw));
const onCredentialMessage = (event: { data: unknown }) => {
	try {
		credentials.receive(event.data);
	} catch {
		credentials.close();
	}
};
parent.on("message", onCredentialMessage);
let agentFiles: TrustedAgentFileService | undefined;
const runtime =
	provider === "deterministic"
		? await openTestRuntime(directory, {
				resume: true,
				agentFiles: () => agentFiles,
				onError: () => process.stderr.write("Runtime operation interrupted; reconcile original receipt.\n"),
			})
		: await openRuntime(directory, {
				models: createProductionModels(credentials),
				credentials,
				resume: false,
				agentFiles: () => agentFiles,
				onError: () => process.stderr.write("Runtime operation interrupted; reconcile original receipt.\n"),
			});
parent.off("message", onCredentialMessage);
const files = await createFileRuntime(runtime, generation, (raw) => parent.postMessage(raw), {
	workerUrl: new URL("./preview-parser.mjs", import.meta.url),
});
agentFiles = files.agentFiles;
const router = createRuntimeRouter(
	runtime,
	generation,
	(raw) => parent.postMessage(raw),
	() => files.close(),
);
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	credentials.close();
	void router.shutdown().then(
		() => process.exit(0),
		() => {
			// Keep the process and writer ownership alive until host observes actual exit.
			process.stderr.write("Runtime shutdown failed; ownership retained.\n");
			try {
				parent.postMessage(encode({ generation, kind: "shutdownFailed" }));
			} catch {
				/* No parent remains to notify. */
			}
		},
	);
};
parent.on("message", (event) => {
	try {
		if (credentials.receive(event.data)) return;
	} catch {
		stop();
		return;
	}
	void files
		.receive(event.data)
		.then((handled) => (handled ? undefined : router.receive(event.data)))
		.catch(() => {
			try {
				parent.postMessage(encode({ generation, kind: "fatal" }));
			} finally {
				stop();
			}
		})
		.catch(() => stop());
});
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
parent.postMessage(encode({ generation, kind: "ready" }));
