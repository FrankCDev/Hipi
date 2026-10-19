import assert from "node:assert/strict";
import { type AgentContext, type AppClient, type Method, type Params, parseResult } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { defaultConfig } from "../src/app/theme/config.ts";
import { themeStorageKey } from "../src/app/theme/store.ts";
import { Dialog } from "../src/components/ui/dialog.tsx";
import { PermissionSession } from "../src/features/agent-permissions/permission-session.ts";
import { RetainedContextConsent } from "../src/features/agent-permissions/retained-context-dialog.tsx";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const source: AgentContext = {
	...scope,
	purpose: "live-files",
	requestId: "original",
	rootId: "old-root",
	pathPrefixes: ["src", "docs"],
	model: { provider: "fake", modelId: "old-model" },
	expiresAt: 1,
	disclosureVersion: 1,
	grantId: "old-grant",
	revision: 2,
	status: "invalidated",
};
afterEach(() => vi.unstubAllGlobals());
function render(locale: "en" | "zh-CN", grant = source, disabled = false) {
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => (key === themeStorageKey ? JSON.stringify({ ...defaultConfig(), locale }) : null),
		},
	});
	let calls = 0;
	const client: AppClient = {
		call: async <M extends Method>(method: M, _params: Params<M>) => {
			calls++;
			return parseResult(method, null);
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const session = new PermissionSession(client, scope);
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<Dialog>
				<RetainedContextConsent
					scope={scope}
					source={grant}
					model={{ provider: "fake", modelId: "selected-model" }}
					session={session}
					disabled={disabled}
					onAuthorized={() => {}}
				/>
			</Dialog>
		</PreferencesProvider>,
	);
	assert.equal(calls, 0, "viewing consent never authorizes or resumes");
	session.dispose();
	return html;
}
test("retained consent shows selected destination, original immutable scope and limited disclosure", () => {
	const html = render("en");
	for (const text of [
		"workspace / conversation",
		"fake / selected-model",
		"old-grant",
		"old-root",
		"src, docs",
		"previously saved file content",
		"derived summaries",
		"does not restore old directory read/write access or old approvals",
		"cannot recall data previously transmitted",
		"Authorization duration",
		"continue this conversation",
		"New file operations require",
	])
		assert.ok(html.includes(text), text);
	assert.doesNotMatch(html, /<textarea|<input/);
	assert.match(html, /Allow historical file context to be sent again/);
});
test("retained consent is bilingual and blocks wrong source role, wrong scope and unavailable actions", () => {
	const zh = render("zh-CN");
	for (const text of [
		"允许再次发送历史文件上下文",
		"不会恢复旧目录读写权",
		"不会复活旧审批",
		"无法撤回",
		"授权期限",
		"继续原会话",
	])
		assert.ok(zh.includes(text), text);
	assert.match(render("en", { ...source, conversationId: "other" }), /disabled=""/);
	assert.match(render("en", { ...source, purpose: "retained-context", sourceGrantId: "old-grant" }), /disabled=""/);
	assert.match(render("en", source, true), /disabled=""/);
});
