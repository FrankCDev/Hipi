import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AppClient, Snapshot } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { AppClientProvider } from "../src/app/client-provider.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ConversationComposer } from "../src/features/workbench/conversation-composer.tsx";
import { ConversationStarters } from "../src/features/workbench/conversation-starters.tsx";
import { useConversation } from "../src/features/workbench/use-conversation.ts";
import { workbenchLabels } from "../src/features/workbench/workbench-labels.ts";

const conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "A specific task",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
const emptySnapshot: Snapshot = {
	workspaceId: "workspace",
	conversationId: "conversation",
	messages: [],
	partial: "",
	partialLength: 0,
	partialTruncated: false,
	running: false,
	historyCursor: null,
};
const client: AppClient = {
	async call() {
		throw new Error("Presentation rendering must not issue a runtime call");
	},
	async observe() {
		throw new Error("Presentation rendering must not start observation");
	},
};
function Fixture({ draft, blocked, snapshot }: { draft: string; blocked: boolean; snapshot?: Snapshot }) {
	const controller = useConversation(conversation);
	return (
		<ConversationComposer
			controller={{ ...controller, draft, blocked, observation: { ...controller.observation, snapshot } }}
			activity={<button type="button">Inspect activity</button>}
			controls={
				<form id="permission-form">
					<button type="submit">Authorize context</button>
				</form>
			}
		/>
	);
}
function renderComposer(draft = "", blocked = false, snapshot: Snapshot | null = emptySnapshot) {
	return renderToStaticMarkup(
		<PreferencesProvider>
			<AppClientProvider client={client}>
				<Fixture draft={draft} blocked={blocked} snapshot={snapshot ?? undefined} />
			</AppClientProvider>
		</PreferencesProvider>,
	);
}
test("composer isolates permission form events while the named send action targets only its task form", () => {
	const html = renderComposer("A deliberate task");
	const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([form]) => form);
	assert.equal(forms.length, 2);
	const task = forms.find((form) => form.includes("composer-form"));
	assert.ok(task);
	assert.match(task, /<textarea/);
	assert.doesNotMatch(task, /Authorize context|composer-controls|<button/);
	const taskId = /id="([^"]+)"/.exec(task)?.[1];
	assert.ok(taskId);
	const send = [...html.matchAll(/<button\b[^>]*>/g)]
		.map(([button]) => button)
		.find((button) => button.includes("composer-submit"));
	assert.ok(send);
	assert.ok(send.includes(`form="${taskId}"`));
	assert.match(send, /type="submit"/);
	assert.match(send, /aria-label="提交任务"/);
	assert.doesNotMatch(send, /disabled=""/);
	assert.ok(html.indexOf("Inspect activity") < html.indexOf("composer-form"));
});
test("empty or blocked drafts retain a disabled submit, including whitespace-only text", () => {
	for (const [draft, blocked] of [
		["", false],
		[" \n ", false],
		["A task", true],
	] as const) {
		const html = renderComposer(draft, blocked);
		const send = [...html.matchAll(/<button\b[^>]*>/g)]
			.map(([button]) => button)
			.find((button) => button.includes("composer-submit"));
		assert.match(send ?? "", /disabled=""/);
	}
});
test("editable starters appear only in a known genuinely empty non-running conversation", () => {
	assert.match(renderComposer(), /conversation-starters/);
	assert.doesNotMatch(renderComposer("", false, null), /conversation-starters/);
	for (const snapshot of [
		{ ...emptySnapshot, running: true },
		{ ...emptySnapshot, historyCursor: "older" },
		{
			...emptySnapshot,
			messages: [{ id: "one", role: "user" as const, text: "hello", textLength: 5, truncated: false }],
		},
	])
		assert.doesNotMatch(renderComposer("", false, snapshot), /conversation-starters/);
});

test("optional motion is confined to floating surfaces and reduced motion disables it", async () => {
	const css = await readFile(new URL("../src/theme.css", import.meta.url), "utf8");
	const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
	const end = css.indexOf("@media (prefers-reduced-motion: reduce)");
	assert.ok(start >= 0 && end > start);
	const motion = css.slice(start, end);
	for (const slot of ["popover-content", "dialog-content", "dialog-overlay"])
		assert.ok(motion.includes(`[data-slot="${slot}"][data-state="open"]`));
	assert.doesNotMatch(motion, /\.composer|\.message|\.conversation-panel|\.work-area|width:|height:/);
	assert.match(css.slice(end), /animation: none;/);
	assert.match(css.slice(end), /transition: none;/);
});
test("starter controls never submit and do not overwrite a non-empty or blocked draft", () => {
	for (const [hasDraft, disabled] of [
		[false, false],
		[true, false],
		[false, true],
	] as const) {
		const html = renderToStaticMarkup(
			<PreferencesProvider>
				<ConversationStarters hasDraft={hasDraft} disabled={disabled} onSelect={() => {}} />
			</PreferencesProvider>,
		);
		const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(([button]) => button);
		assert.equal(buttons.length, 3);
		for (const button of buttons) {
			assert.match(button, /type="button"/);
			assert.equal(button.includes('disabled=""'), hasDraft || disabled);
		}
	}
	for (const locale of ["en", "zh-CN"]) {
		const labels = workbenchLabels(locale);
		for (const kind of ["plan", "write", "solve"] as const) {
			assert.ok(labels[`workbench.starter.${kind}`].length);
			assert.ok(labels[`workbench.starter.${kind}Prompt`].length > labels[`workbench.starter.${kind}`].length);
		}
	}
});
