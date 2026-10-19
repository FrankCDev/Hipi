/** Child-only failure injection, installed before the real CLI's IPC handler. */
import { DatabaseSync } from "node:sqlite";

const original = DatabaseSync.prototype.close;
let closing = false;
process.on("message", (message: unknown) => {
	if (message && typeof message === "object" && "type" in message && message.type === "hipi.dev-host.shutdown")
		closing = true;
});
DatabaseSync.prototype.close = function () {
	if (closing) throw new Error("Injected host database close failure");
	return original.call(this);
};
