import assert from "node:assert/strict";
import type { ToolActivity } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import type { ActivityState } from "../src/features/tool-activities/activity-session.ts";
import {
	ActivityTranscriptProvider,
	InlineMessageActivities,
} from "../src/features/tool-activities/activity-transcript.tsx";
import { ToolActivities } from "../src/features/tool-activities/tool-activities.tsx";

const fixture = vi.hoisted(() => ({ state: { busy: false, failed: false } as ActivityState, owners: 0, locale: "en" }));
vi.mock("../src/app/client-provider.tsx", () => ({ useAppClient: () => ({}) }));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: fixture.locale }) }));
vi.mock("../src/features/tool-activities/activity-session.ts", () => ({
	ActivitySession: class {
		constructor() {
			fixture.owners++;
		}
		snapshot = () => fixture.state;
		subscribe = () => () => {};
	},
}));
const activity: ToolActivity = {
	activityId: "task:1",
	callId: "call",
	toolName: "hipi_files_read",
	source: "task",
	inherited: false,
	anchor: { assistantEntryId: "31", modelIndex: 2, contentIndex: 1 },
	phase: "terminal",
	outcome: "completed",
	toolResult: "success",
	abortRequested: false,
	receiptIds: [],
	textAvailable: true,
	outputTruncated: false,
};
beforeEach(() => {
	fixture.owners = 0;
	fixture.locale = "en";
	fixture.state = {
		busy: false,
		failed: false,
		page: { items: [activity], coverage: "tasks", nextCursor: null, membershipFence: "fence" },
	};
});
function render(messageId: string) {
	const scope = { workspaceId: "w", conversationId: "c" };
	return renderToStaticMarkup(
		<ActivityTranscriptProvider scope={scope} connected running={false}>
			<InlineMessageActivities messageId={messageId} />
			<ToolActivities scope={scope} connected running={false} />
		</ActivityTranscriptProvider>,
	);
}
test("exact anchored activities render inline and compact disclosure shares one read owner", () => {
	const html = render("31_2");
	assert.equal(fixture.owners, 1);
	assert.match(html, /data-activity-message-id="31_2"/);
	assert.match(html, /inline-activity-toggle/);
	assert.match(html, /aria-expanded="false"/);
	assert.match(html, /Read file/);
	assert.match(html, /View activity/);
	assert.doesNotMatch(html, /retained-output|<pre/);
});
test("unassociated activities and different model slots never attach to a convenient response", () => {
	for (const id of ["31_0", "32_2", "latest", "31"]) {
		assert.doesNotMatch(render(id), /inline-activity-toggle/);
	}
	fixture.state = {
		...fixture.state,
		page: {
			items: [{ ...activity, anchor: undefined }],
			coverage: "tasks",
			nextCursor: null,
			membershipFence: "fence",
		},
	};
	assert.doesNotMatch(render("31_2"), /inline-activity-toggle/);
	assert.match(render("31_2"), /View activity/);
});
test("inline activity labels follow locale and preserve unavailable evidence rather than invent completion", () => {
	fixture.locale = "zh";
	fixture.state = {
		...fixture.state,
		page: {
			items: [{ ...activity, phase: "unavailable", outcome: undefined, toolResult: "unavailable" }],
			coverage: "tasks",
			nextCursor: null,
			membershipFence: "fence",
		},
	};
	const html = render("31_2");
	assert.match(html, /读取文件/);
	assert.doesNotMatch(html, /Execution completed|执行完成/);
});
