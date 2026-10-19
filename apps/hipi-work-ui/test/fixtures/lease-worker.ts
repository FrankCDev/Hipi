import { parentPort } from "node:worker_threads";
import { acquireStoreLease } from "../../src/app/connection.ts";

await acquireStoreLease("terminated-owner-store", navigator.locks);
parentPort?.postMessage("acquired");
// Keep the worker alive until its owner simulates an abrupt tab/process termination.
setInterval(() => {}, 1000);
