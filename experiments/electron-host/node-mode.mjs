import assert from "node:assert/strict";
import { probeSqlite } from "./sqlite-probe.mjs";

assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
console.log(JSON.stringify({ mode: "embedded-node-only", ...probeSqlite() }));
