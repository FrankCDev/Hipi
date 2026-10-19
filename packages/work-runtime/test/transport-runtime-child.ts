import { openTestRuntime } from "../src/testing.ts";
import { serveNodeIpc } from "../src/transport-ipc.ts";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("A test directory and inherited IPC channel are required");
const runtime = await openTestRuntime(directory, { tokensPerSecond: 200, resume: true });
const stop = serveNodeIpc(runtime);
process.send("ready");
process.once("disconnect", () => {
	stop();
	void runtime.close().catch(() => {
		process.exitCode = 1;
	});
});
