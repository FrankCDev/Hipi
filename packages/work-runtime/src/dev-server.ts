/** Local acceptance host. The provider must be explicitly selected; openai is opt-in and requires an explicitly supplied in-memory key. */

import { parseArgs } from "node:util";
import { createRuntimeFileHost, parseHostFileMapping } from "./files/host.ts";
import type { TrustedAgentFileService } from "./files/service.ts";
import { createMemoryCredentials } from "./memory-credentials.ts";
import { createProductionModels } from "./model-provider.ts";
import { openRuntime } from "./node.ts";
import { createRuntimePreviewHost } from "./previews/host.ts";
import { openTestRuntime } from "./testing.ts";
import { serveLoopback } from "./transport-http.ts";

const { values } = parseArgs({
	options: {
		provider: { type: "string" },
		origin: { type: "string" },
		data: { type: "string" },
		"file-root": { type: "string", multiple: true },
	},
});
if (!["deterministic", "openai"].includes(values.provider ?? "") || !values.origin || !values.data) {
	throw new Error(
		"Usage: --provider deterministic|openai --origin http://127.0.0.1:5173 --data /absolute/private/data-directory",
	);
}
const mappings = (values["file-root"] ?? []).map(parseHostFileMapping);
const vault = createMemoryCredentials();
// The host binds its one file authority before exposing any transport to clients.
let agentFiles: TrustedAgentFileService | undefined;
const onError = () => {
	process.stderr.write("Runtime operation interrupted; query the original request receipt.\n");
};
const runtime =
	values.provider === "openai"
		? await openRuntime(values.data, {
				models: createProductionModels(vault.port),
				credentials: vault.port,
				resume: false,
				agentFiles: () => agentFiles,
				onError,
			})
		: await openTestRuntime(values.data, { resume: true, onError, agentFiles: () => agentFiles });
const files = await createRuntimeFileHost(runtime, "http-session").catch(async (error: unknown) => {
	await runtime.close();
	vault.clear();
	throw error;
});
agentFiles = files.authority.forAgent("http-session");
const previews = createRuntimePreviewHost({
	authority: files.authority,
	principalId: "http-session",
	storeId: files.storeId,
});
try {
	for (const mapping of mappings) await files.authority.grantRoot({ ...mapping, principalId: "http-session" });
	const server = await serveLoopback(runtime, {
		origin: values.origin,
		files: files.handler,
		previews: previews.handler,
		...(values.provider === "openai" ? { credentials: vault.management } : {}),
		onDiagnostic: ({ code, reason }) => {
			process.stderr.write(
				`Local API rejected request: ${code}${reason ? ` (${reason})` : ""}. Check the UI origin and connection settings.\n`,
			);
		},
	});
	// Ephemeral local capability, shown only to the operator; never persisted or put in a URL.
	process.stdout.write(
		`${values.provider === "openai" ? "OpenAI mode: requests may incur charges. Keys are memory-only and cleared on host restart. History opens without automatic execution resume." : "Deterministic acceptance provider only; no external model or tools."}\nAllowed UI Origin: ${values.origin}\nAPI: ${server.url}\nToken: ${server.token}\n`,
	);
	let closing: Promise<void> | undefined;
	const shutdown = () => {
		closing ??= (async () => {
			await server.close();
			await previews.close();
			await files.authority.close();
			await runtime.close();
			vault.clear();
		})();
		return closing;
	};
	const requestShutdown = () => {
		void shutdown().then(
			() => {
				if (process.connected) process.disconnect();
			},
			() => {
				process.exitCode = 1;
				if (process.connected) process.disconnect();
			},
		);
	};
	process.once("SIGINT", requestShutdown);
	process.once("SIGTERM", requestShutdown);
	// An inherited Node IPC channel is a parent capability, not a network API. Windows
	// kill(SIGTERM) is a forced termination, so forked hosts need an explicit graceful path.
	if (process.send) {
		process.on("message", (message: unknown) => {
			if (
				message &&
				typeof message === "object" &&
				!Array.isArray(message) &&
				Object.keys(message).length === 1 &&
				"type" in message &&
				message.type === "hipi.dev-host.shutdown"
			)
				requestShutdown();
		});
		process.once("disconnect", requestShutdown);
	}
} catch (error) {
	await previews.close();
	await files.authority.close();
	await runtime.close();
	vault.clear();
	throw error;
}
