import assert from "node:assert/strict";
import { probeRuntime } from "./runtime-probe.mjs";

assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
console.log(JSON.stringify({ mode: "embedded-node-runtime-only", ...await probeRuntime() }));
