import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFiles } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const groups = [
	[
		"apps/hipi-work-desktop/test",
		"credentials lifecycle host host-messages diagnostics previews files startup-assets runtime-recovery runtime-resource",
	],
	[
		"packages/work-runtime/test",
		"dev-server-openai core workspace-cache node-cache node-unsafe history history-fork transport previews-service agent-contracts agent-capacity capacity-contracts capacity-archival extension-pack extension-lifecycle extension-checkpoint extension-tools tool-pack-contracts tool-pack-transport-runtime tool-activity-contracts feature-readonly tool-activities tool-activities-runtime document-checkpoints model-provider document-parsers dev-server files-transport files-host-access transport-runtime catalog identity credentials-http previews-http history-contracts files files-snapshot runtime-model files-agent agent-tools model-gate transport-auth",
	],
	[
		"apps/hipi-work-ui/test",
		"history-reads conversation-dynamic-layout conversation-virtualizer file-client bounded-read composer-input desktop-client conversation-history-controller theme-application message-projection local-state receipt-reconciliation preview-client conversation-preview-interaction connection local-persistence conversation-measurement-policy file-editor-session artifact-editor reopen-request preview-session editor-input-limit theme-settings execution-outcome",
	],
];
const nodeTests = groups.flatMap(([directory, names]) =>
	names.split(" ").map((name) => `${directory}/${name}.test.ts`),
);
nodeTests.push("apps/hipi-work-desktop/scripts/release-policy.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/verify-pack.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/release-download.test.mjs");
nodeTests.push("packages/work-runtime/test/store-backup.test.ts");
nodeTests.push("packages/work-runtime/test/recovery-archive.test.ts");
nodeTests.push("packages/work-runtime/test/store-cli.test.ts");
nodeTests.push("packages/work-runtime/test/sqlite-durability.test.ts");
const storageTests = [
	"packages/chord/test/sqlite-readonly.test.ts",
	"packages/chord/test/sqlite/node.test.ts",
	"packages/durable/test/sqlite-readonly.test.ts",
	"packages/durable/test/sqlite-storage.test.ts",
	"packages/durable/test/sqlite-facade.test.ts",
	"packages/durable/test/sqlite-migrations.test.ts",
];
const uiTests = [
	"agent-permission-card",
	"retained-context-consent",
	"file-panel",
	"file-workbench",
	"appearance-settings",
	"archived-conversation",
	"document-preview",
	"input-group",
	"workspace-tree",
	"message-markdown",
	"conversation-preview",
	"tool-activities",
	"tool-packs-ui",
].map((name) => `apps/hipi-work-ui/test/${name}.test.tsx`);
uiTests.push("apps/hipi-work-ui/test/agent-permissions.test.ts");
uiTests.push("apps/hipi-work-ui/test/model-configuration.test.ts");
uiTests.push("apps/hipi-work-ui/test/context-paths.test.ts");
uiTests.push("apps/hipi-work-ui/test/catalog-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/command-recovery.test.ts");
uiTests.push("apps/hipi-work-ui/test/tool-packs.test.ts");
uiTests.push("apps/hipi-work-ui/test/artifact-navigation.test.ts");
// Node 24 may silently ignore nonexistent test paths. Check every explicit file first.
await requireFiles(root, [...nodeTests, ...uiTests, ...storageTests]);
function run(script, args = [], cwd = root) {
	const result = spawnSync(process.execPath, [script.startsWith("--") ? script : resolve(root, script), ...args], {
		cwd,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
run("packages/ai/scripts/check-model-data.ts");
for (const workspace of ["packages/work-runtime", "apps/hipi-work-ui", "apps/hipi-work-desktop"]) {
	run("node_modules/typescript/bin/tsc", ["--noEmit", "-p", `${workspace}/tsconfig.json`]);
}
run("apps/hipi-work-desktop/scripts/check-boundaries.mjs");
run("apps/hipi-work-desktop/scripts/check-brand-icons.mjs");
run("packages/work-runtime/scripts/check-browser.mjs", [], resolve(root, "packages/work-runtime"));
run("--conditions=source", ["--test", "--test-concurrency=2", ...nodeTests]);
run("node_modules/vitest/vitest.mjs", ["run", "--maxWorkers=2", "--config", "vitest.base.ts", ...uiTests]);
// Durable's own config supplies source exports and current-only retention setup.
// Do not replace it with the renderer-oriented root config.
for (const workspace of ["packages/chord", "packages/durable"]) {
	run(
		"node_modules/vitest/vitest.mjs",
		[
			"run",
			"--maxWorkers=2",
			...storageTests
				.filter((file) => file.startsWith(`${workspace}/`))
				.map((file) => file.slice(workspace.length + 1)),
		],
		resolve(root, workspace),
	);
}
console.log("Explicit Hipi source checks passed. This does not exercise native Electron GUI or paid providers.");
