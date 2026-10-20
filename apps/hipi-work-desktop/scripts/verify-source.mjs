import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFiles } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const groups = [
	[
		"apps/hipi-work-desktop/test",
		"credentials lifecycle host host-messages diagnostics previews files startup-assets runtime-recovery runtime-resource appearance native-fonts smoke-model-fixture",
	],
	[
		"packages/work-runtime/test",
		"dev-server-openai core workspace-cache node-cache node-unsafe history history-fork transport previews-service agent-contracts agent-capacity capacity-contracts capacity-archival extension-pack extension-lifecycle extension-checkpoint extension-tools tool-pack-contracts tool-pack-transport-runtime tool-activity-contracts feature-readonly tool-activities tool-activities-runtime document-checkpoints model-provider document-parsers dev-server files-transport files-host-access transport-runtime catalog identity credentials-http previews-http history-contracts files files-snapshot runtime-model files-agent agent-tools model-gate transport-auth stream-identity stream-identity-runtime",
	],
	[
		"apps/hipi-work-ui/test",
		"history-reads conversation-dynamic-layout conversation-virtualizer file-client bounded-read composer-input desktop-client conversation-history-controller message-projection local-state receipt-reconciliation preview-client conversation-preview-interaction connection local-persistence conversation-measurement-policy file-editor-session artifact-editor reopen-request preview-session editor-input-limit execution-outcome conversation-scroll-intent conversation-reading-position conversation-transcript clipboard-feedback markdown-segments streaming-text-buffer response-announcement syntax-highlight file-search-replacement",
	],
];
const nodeTests = groups.flatMap(([directory, names]) =>
	names.split(" ").map((name) => `${directory}/${name}.test.ts`),
);
nodeTests.push("apps/hipi-work-desktop/scripts/release-policy.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/verify-pack.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/release-download.test.mjs");
nodeTests.push("apps/hipi-work-desktop/test/smoke-profile.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/credential-diagnostics.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/credential-crypto.test.ts");
nodeTests.push("apps/hipi-work-desktop/scripts/cdp.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-process.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-flow.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-work-experience.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-settings-route.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-project-disclosure.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/smoke-packaged-gui.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-profile-evidence.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-native-log.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-fonts.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-native-appearance.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-windows-dialogs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/font-assets.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/pierre-licenses.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/codemirror-licenses.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-tool-packs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-long-history.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-long-history-fixture.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-file-workbench.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/linux-maintenance.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-between-runs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/packaging/appimage-launcher.test.mjs");
nodeTests.push("apps/hipi-work-desktop/test/probe-linux-sandbox.test.mjs");
nodeTests.push("packages/work-runtime/test/store-backup.test.ts");
nodeTests.push("packages/work-runtime/test/recovery-archive.test.ts");
nodeTests.push("packages/work-runtime/test/store-cli.test.ts");
nodeTests.push("packages/work-runtime/test/sqlite-durability.test.ts");
nodeTests.push("packages/work-runtime/test/transport-backpressure.test.ts");
nodeTests.push("packages/work-runtime/test/office-zip-normalization.test.ts");
const storageTests = [
	"packages/chord/test/sqlite-readonly.test.ts",
	"packages/chord/test/sqlite/node.test.ts",
	"packages/durable/test/sqlite-readonly.test.ts",
	"packages/durable/test/sqlite-storage.test.ts",
	"packages/durable/test/sqlite-facade.test.ts",
	"packages/durable/test/sqlite-migrations.test.ts",
];
const uiTests = [
	"activity-approval-presentation",
	"activity-transcript",
	"conversation-selection-interaction",
	"file-canvas-presentation",
	"work-experience-presentation",
	"prepared-task-entry",
	"dialog-placement",
	"agent-permission-card",
	"permission-presentation",
	"retained-context-consent",
	"file-panel",
	"file-workbench",
	"file-search",
	"file-line-navigation",
	"file-tab-actions",
	"markdown-presentation",
	"markdown-file-interaction",
	"file-workspace-layout",
	"file-splitter-interaction",
	"file-revocation-interaction",
	"appearance-settings",
	"settings-dialog",
	"settings-workflow",
	"conversation-capabilities",
	"conversation-capabilities-interaction",
	"conversation-preview-card",
	"tool-packs-panel-lifecycle",
	"archived-conversation",
	"conversation-model-refresh",
	"document-preview",
	"input-group",
	"shared-control-primitives",
	"workspace-tree",
	"workspace-navigation-interaction",
	"catalog-pages",
	"sidebar-navigation-callbacks",
	"workspace-tree-callbacks",
	"message-markdown",
	"syntax-code",
	"user-message-content",
	"conversation-preview",
	"tool-activities",
	"tool-packs-ui",
].map((name) => `apps/hipi-work-ui/test/${name}.test.tsx`);
uiTests.push("apps/hipi-work-ui/test/agent-permissions.test.ts");
uiTests.push("apps/hipi-work-ui/test/font-fallback.test.ts");
uiTests.push("apps/hipi-work-ui/test/appearance-client.test.ts");
uiTests.push("apps/hipi-work-ui/test/theme-settings.test.ts");
uiTests.push("apps/hipi-work-ui/test/theme-application.test.ts");
uiTests.push("apps/hipi-work-ui/test/model-configuration.test.ts");
uiTests.push("apps/hipi-work-ui/test/context-paths.test.ts");
uiTests.push("apps/hipi-work-ui/test/catalog-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/prepared-task.test.ts");
uiTests.push("apps/hipi-work-ui/test/initial-send.test.ts");
uiTests.push("apps/hipi-work-ui/test/command-recovery.test.ts");
uiTests.push("apps/hipi-work-ui/test/tool-packs.test.ts");
uiTests.push("apps/hipi-work-ui/test/artifact-navigation.test.ts");
uiTests.push("apps/hipi-work-ui/test/file-tree-adapter.test.ts");
uiTests.push("apps/hipi-work-ui/test/file-workspace-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/pierre-editor.test.ts");
uiTests.push("apps/hipi-work-ui/test/markdown-line-endings.test.ts");
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
// A stuck test must produce a failure instead of silently consuming the whole CI job.
// Explicit per-test deadlines can be stricter; no scenario is skipped on timeout.
// TAP emits each failure's details immediately, even if a later test leaves handles open.
run("--conditions=source", [
	"--test",
	"--test-reporter=tap",
	"--test-timeout=120000",
	"--test-concurrency=2",
	...nodeTests,
]);
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
