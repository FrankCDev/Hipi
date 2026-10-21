import { Socket } from "node:net";
import { openRuntime } from "../src/node.ts";
import { serveNodeIpc } from "../src/transport-ipc.ts";
import { heldResponse } from "./helpers/held-response.ts";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("A test directory and inherited IPC channel are required");
// Separate inherited pipe: no release message ever enters the production IPC protocol.
const control = process.argv[3] === "release" ? new Socket({ fd: 4, readable: true, writable: false }) : undefined;
const closeControl = () => {
	control?.removeAllListeners("data");
	control?.removeAllListeners("end");
	control?.destroy();
};
const fixture = heldResponse(closeControl);
control?.once("data", (chunk: Buffer) => {
	try {
		if (chunk.length === 1 && chunk[0] === 1) fixture.release();
		else fixture.dispose();
	} catch {
		fixture.dispose();
	} finally {
		closeControl();
	}
});
control?.once("end", () => {
	fixture.dispose();
	closeControl();
});
control?.once("error", () => {
	fixture.dispose();
	closeControl();
});
const runtime = await openRuntime(directory, {
	models: fixture.models,
	model: { provider: "faux", modelId: "faux-1" },
	resume: true,
});
const stop = serveNodeIpc(runtime);
process.send("ready");
process.once("disconnect", () => {
	fixture.dispose();
	closeControl();
	stop();
	void runtime.close().catch(() => {
		process.exitCode = 1;
	});
});
