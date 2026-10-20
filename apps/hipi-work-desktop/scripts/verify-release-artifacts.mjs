import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { verifyReleaseArtifacts } from "./release-artifacts.mjs";

const { values } = parseArgs({
	options: Object.fromEntries(
		["directory", "version", "platform", "architecture", "channel"].map((name) => [name, { type: "string" }]),
	),
});
for (const name of ["directory", "version", "platform", "architecture", "channel"])
	assert.ok(values[name], `Required option: --${name}`);
const artifacts = await verifyReleaseArtifacts(values.directory, values);
console.log(
	JSON.stringify({ integrity: "verified", artifacts, nativeTrust: "not_checked", productAcceptance: "not_checked" }),
);
