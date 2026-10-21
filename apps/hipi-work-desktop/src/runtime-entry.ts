import type { TrustedAgentFileService } from "@hipi/work-runtime/files/node";
import { createProductionModels } from "@hipi/work-runtime/model-provider";
import { openRuntime } from "@hipi/work-runtime/node";
import { openTestRuntime } from "@hipi/work-runtime/testing";
import { CredentialRpc } from "./credentials/rpc.ts";
import { diagnoseRuntimeOperation, runtimeDiagnosticReporter } from "./diagnostics/runtime.ts";
import { createFileRuntime } from "./files/runtime.ts";
import { command, encode, identifier } from "./ipc/protocol.ts";
import { runtimeSmokeFixture } from "./launch/smoke-fixture.ts";
import { createRuntimeRouter } from "./runtime/router.ts";

const [directory, rawGeneration, provider, ...fixtureArguments] = process.argv.slice(2);
if (!directory || (provider !== "deterministic" && provider !== "production"))
	throw new Error("Explicit provider mode is required");
const generation = identifier(rawGeneration);
const responseFixture = runtimeSmokeFixture(directory, provider, fixtureArguments);
const parent = process.parentPort;
if (!parent) throw new Error("Electron utility parentPort is required");
const credentials = new CredentialRpc(generation, (raw) => parent.postMessage(raw));
const report = runtimeDiagnosticReporter(generation, (raw) => parent.postMessage(raw));
const onCredentialMessage = (event: { data: unknown }) => {
	try {
		credentials.receive(event.data);
	} catch {
		credentials.close();
	}
};
parent.on("message", onCredentialMessage);
async function startRuntime() {
	let agentFiles: TrustedAgentFileService | undefined;
	const runtime = await diagnoseRuntimeOperation(
		() =>
			provider === "deterministic"
				? openTestRuntime(directory, {
						responseFixture,
						resume: true,
						agentFiles: () => agentFiles,
						onError: () => report({ category: "operation", phase: "unknown" }),
						onDiagnostic: report,
					})
				: openRuntime(directory, {
						models: createProductionModels(credentials),
						credentials,
						resume: false,
						agentFiles: () => agentFiles,
						onError: () => report({ category: "operation", phase: "unknown" }),
						onDiagnostic: report,
					}),
		{ category: "startup", phase: "runtime-open" },
		report,
	);
	parent.off("message", onCredentialMessage);
	const files = await diagnoseRuntimeOperation(
		() =>
			createFileRuntime(runtime, generation, (raw) => parent.postMessage(raw), {
				workerUrl: new URL("./preview-parser.mjs", import.meta.url),
			}),
		{ category: "startup", phase: "file-services-open" },
		report,
	);
	agentFiles = files.agentFiles;
	const router = createRuntimeRouter(
		runtime,
		generation,
		(raw) => parent.postMessage(raw),
		() => files.close(),
		report,
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
				report({ category: "operation", phase: "dispatch" });
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
}
void startRuntime().catch(() => {
	credentials.close();
	parent.off("message", onCredentialMessage);
	// Startup may have retained live writers. Wait for the host's shutdown or actual process exit.
	parent.on("message", (event) => {
		try {
			const message = command(event.data);
			if (message.generation === generation && message.kind === "shutdown") process.exit(1);
		} catch {
			/* No unvalidated frame can end writer ownership. */
		}
	});
	try {
		parent.postMessage(encode({ generation, kind: "fatal" }));
	} catch {
		/* Host termination will end the utility process. */
	}
});
