import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ConversationTurnFailure } from "../src/features/workbench/conversation-turn-failure.tsx";

test("terminal failure is a restrained transcript status with settings, never a retry or raw diagnostic", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationTurnFailure
				failure={{ key: "request", modelFailure: { category: "model_network_failed", dispatch: "unknown" } }}
				onOpenModelSettings={() => {}}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /conversation-turn-failure/);
	// The stable transcript announcer owns live updates, not virtual row mounts.
	assert.doesNotMatch(html, /role="status"|aria-live|<output/);
	assert.match(html, /模型设置/);
	assert.match(html, /尚无法确认请求是否已发送/);
	assert.doesNotMatch(html, /class="notice|composer-recovery|重试|重新发送|Retry|Resend/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test("settings action is omitted when no functional navigation is available", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationTurnFailure failure={{ key: "request", modelFailure: undefined }} />
		</PreferencesProvider>,
	);
	assert.doesNotMatch(html, /<button/);
	assert.match(html, /尚无法确认/);
});

test("context authorization failures direct to permissions without an irrelevant model-settings action", () => {
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationTurnFailure
				failure={{ key: "request", modelFailure: { category: "model_context_blocked", dispatch: "not_sent" } }}
				onOpenModelSettings={() => {}}
			/>
		</PreferencesProvider>,
	);
	assert.match(html, /检查权限设置/);
	assert.doesNotMatch(html, /<button|模型设置/);
});
