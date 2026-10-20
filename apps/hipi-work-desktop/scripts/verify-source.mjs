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
		"apps/hipi-work-ui/test/workbench/conversation",
		"history-reads conversation-dynamic-layout conversation-virtualizer conversation-history-controller message-projection conversation-measurement-policy execution-outcome conversation-scroll-intent conversation-reading-position conversation-transcript response-announcement",
	],
	[
		"apps/hipi-work-ui/test",
		"file-client desktop-client preview-client connection file-editor-session artifact-editor preview-session editor-input-limit file-search-replacement css-cascade",
	],
	[
		"apps/hipi-work-ui/test/workbench",
		"bounded-read local-state receipt-reconciliation local-persistence reopen-request",
	],
	["apps/hipi-work-ui/test/workbench/composer", "composer-input"],
	["apps/hipi-work-ui/test/workbench/sidebar", "conversation-preview-interaction"],
	[
		"apps/hipi-work-ui/test/workbench/conversation/markdown",
		"clipboard-feedback markdown-segments streaming-text-buffer syntax-highlight",
	],
];
const nodeTests = groups.flatMap(([directory, names]) =>
	names.split(" ").map((name) => `${directory}/${name}.test.ts`),
);
nodeTests.push("apps/hipi-work-desktop/scripts/release-policy.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/production-policy.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/release-artifacts.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/verify-native-release.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/verify-pack.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/release-download.test.mjs");
nodeTests.push("apps/hipi-work-desktop/test/smoke-profile.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/credential-diagnostics.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/credential-crypto.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/connection-lifetime.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/conversation/conversation-failure.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/conversation/observation-session.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/catalog/initial-context-runtime.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/sidebar/sidebar-preview-metadata.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/sidebar/preview-coordinator.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/projects/project-folder-cascade.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/conversation/anchored-history-controller.test.ts");
nodeTests.push("apps/hipi-work-ui/test/workbench/search/conversation-search-integration.test.ts");
nodeTests.push("apps/hipi-work-desktop/scripts/cdp.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-process.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-flow.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-work-experience.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-settings-route.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-project-disclosure.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-project-binding.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-conversation-pin.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-conversation-search.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-sidebar-hover.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/smoke-packaged-gui.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-profile-evidence.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-native-log.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-fonts.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-native-appearance.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-windows-dialogs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/font-assets.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/bundle-owner.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-tool-packs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-long-history.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-long-history-fixture.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-file-workbench.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-file-editor-escape.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-file-reopen.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/linux-maintenance.test.mjs");
nodeTests.push("apps/hipi-work-desktop/scripts/gui-between-runs.test.mjs");
nodeTests.push("apps/hipi-work-desktop/packaging/appimage-launcher.test.mjs");
nodeTests.push("apps/hipi-work-desktop/test/probe-linux-sandbox.test.mjs");
nodeTests.push("packages/work-runtime/test/store-backup.test.ts");
nodeTests.push("packages/work-runtime/test/custom-providers.test.ts");
nodeTests.push("packages/work-runtime/test/project-folder-backup.test.ts");
nodeTests.push("packages/work-runtime/test/project-folders.test.ts");
nodeTests.push("packages/work-runtime/test/conversation-presentation.test.ts");
nodeTests.push("packages/work-runtime/test/presentation-backup.test.ts");
nodeTests.push("packages/work-runtime/test/pinned-reorder.test.ts");
nodeTests.push("packages/work-runtime/test/conversation-search.test.ts");
nodeTests.push("packages/work-runtime/test/search-projection.test.ts");
nodeTests.push("packages/work-runtime/test/search-backup.test.ts");
nodeTests.push("packages/work-runtime/test/search-fork.test.ts");
nodeTests.push("apps/hipi-work-desktop/test/project-folders.test.ts");
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
	"workbench/conversation/conversation-selection-interaction",
	"workbench/search/conversation-search-interaction",
	"workbench/files/file-canvas-presentation",
	"workbench/composer/work-experience-presentation",
	"workbench/composer/prepared-task-entry",
	"dialog-placement",
	"agent-permission-card",
	"permission-presentation",
	"retained-context-consent",
	"workbench/files/file-panel",
	"workbench/files/file-panel-escape",
	"file-workbench",
	"file-search",
	"file-line-navigation",
	"file-tab-actions",
	"workbench/conversation/markdown/markdown-presentation",
	"workbench/conversation/markdown/markdown-file-interaction",
	"file-workspace-layout",
	"workbench/files/file-splitter-interaction",
	"file-revocation-interaction",
	"appearance-settings",
	"appearance-provider",
	"settings-dialog",
	"settings-workflow",
	"custom-provider-settings",
	"legacy-provider-editor",
	"workbench/conversation/conversation-turn-failure",
	"workbench/conversation/conversation-draft-recovery",
	"workbench/conversation/observation-recovery-ui",
	"workbench/projects/project-folder-interaction",
	"conversation-capabilities",
	"conversation-capabilities-interaction",
	"workbench/sidebar/conversation-preview-card",
	"workbench/sidebar/project-preview-card",
	"workbench/sidebar/sidebar-title",
	"workbench/sidebar/sidebar-title-lifecycle",
	"workbench/sidebar/sidebar-drag-provider",
	"workbench/sidebar/sidebar-dnd-integration",
	"workbench/sidebar/preview-provider",
	"tool-packs-panel-lifecycle",
	"workbench/conversation/archived-conversation",
	"workbench/conversation/conversation-model-refresh",
	"document-preview",
	"input-group",
	"shared-control-primitives",
	"workbench/sidebar/workspace-tree",
	"workbench/sidebar/pin-interactions",
	"workbench/workspace-navigation-interaction",
	"workbench/catalog/catalog-pages",
	"workbench/sidebar/sidebar-navigation-callbacks",
	"workbench/sidebar/workspace-tree-callbacks",
	"workbench/conversation/markdown/message-markdown",
	"workbench/conversation/markdown/syntax-code",
	"workbench/conversation/markdown/user-message-content",
	"workbench/sidebar/conversation-preview",
	"tool-activities",
	"tool-packs-ui",
].map((name) => `apps/hipi-work-ui/test/${name}.test.tsx`);
uiTests.push("apps/hipi-work-ui/test/agent-permissions.test.ts");
uiTests.push("apps/hipi-work-ui/test/font-fallback.test.ts");
uiTests.push("apps/hipi-work-ui/test/appearance-client.test.ts");
uiTests.push("apps/hipi-work-ui/test/theme-settings.test.ts");
uiTests.push("apps/hipi-work-ui/test/theme-application.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/model-configuration.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/projects/project-folder-change.test.ts");
uiTests.push("apps/hipi-work-ui/test/context-paths.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/catalog/catalog-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/presentation-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/sidebar-title-motion.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/search/conversation-search-controller.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/sidebar-layout-session.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/sidebar-drag-controller.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/sidebar-pointer-sensor.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/sidebar/pinned-order-actions.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/catalog/prepared-task.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/catalog/initial-send.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/catalog/initial-context-send.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/command-recovery.test.ts");
uiTests.push("apps/hipi-work-ui/test/tool-packs.test.ts");
uiTests.push("apps/hipi-work-ui/test/workbench/files/artifact-navigation.test.ts");
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
// Native Windows observation keeps its original deadlines, but does not compete
// with another source-test process during cold PowerShell/Electron startup.
// Portable observer/security cases remain in the ordinary batch on other hosts.
const windowsNativeTest = "apps/hipi-work-desktop/scripts/gui-windows-dialogs.test.mjs";
const nodeTestGroups =
	process.platform === "win32"
		? [nodeTests.filter((file) => file !== windowsNativeTest), [windowsNativeTest]]
		: [nodeTests];
for (const tests of nodeTestGroups) {
	run("--conditions=source", [
		"--test",
		"--test-reporter=tap",
		"--test-timeout=120000",
		`--test-concurrency=${tests.length === 1 ? 1 : 2}`,
		...tests,
	]);
}
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
