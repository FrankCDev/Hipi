/** Source-only IPC fixture. No configured credentials and no model requests. */
import { createProductionModels } from "../../src/model-provider.ts";
import { openRuntime } from "../../src/node.ts";
import { serveNodeIpc } from "../../src/transport-ipc.ts";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("Fixture requires inherited IPC and storage directory");
const credentials = {
	status: async () => "missing" as const,
	get: async () => {
		throw new Error("Fixture must not read credentials");
	},
};
const runtime = await openRuntime(directory, { models: createProductionModels(credentials), credentials });
const stop = serveNodeIpc(runtime);
process.once("disconnect", () => {
	stop();
	void runtime.close().catch(() => {
		process.exitCode = 1;
	});
});
