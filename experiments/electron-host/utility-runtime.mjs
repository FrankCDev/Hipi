import { probeRuntime } from "./runtime-probe.mjs";

const port = process.parentPort;
if (!port) throw new Error("Expected an Electron utility process");
const timeout = setTimeout(() => process.exit(2), 10000);
port.once("message", (event) => {
	clearTimeout(timeout);
	process.exit(event.data === "probe-received" ? 0 : 1);
});
port.postMessage(await probeRuntime());
