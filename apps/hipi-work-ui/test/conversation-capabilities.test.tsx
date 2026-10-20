import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ConversationCapabilities } from "../src/features/conversation-capabilities/conversation-capabilities.tsx";

const fixture = vi.hoisted(() => ({
	open: false,
	section: null as "files" | "tool-packs" | null,
	locale: "en",
	permissionOwners: 0,
	packOwners: 0,
	permissionVisible: false,
	packActive: false,
}));
// Exercise the surface states without a DOM. The management owners' effects and
// real session recovery are covered separately; focus behavior remains a native GUI gate.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useState: (initial: unknown) => actual.useState(initial === null ? fixture.section : initial),
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale: fixture.locale }) }));
vi.mock("../src/components/ui/dialog.tsx", () => ({
	Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	DialogContent: ({ children }: { children: React.ReactNode }) =>
		fixture.open ? <div role="dialog">{children}</div> : null,
	DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
	DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
	DialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../src/components/ui/dropdown-menu.tsx", () => ({
	DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div role="menu">{children}</div>,
	DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../src/features/agent-permissions/agent-permissions.tsx", () => ({
	AgentPermissionManagement: ({
		detailsOpen,
		children,
	}: {
		detailsOpen: boolean;
		children: (view: {
			content: React.ReactNode;
			attention: React.ReactNode;
			contextAction: { disabled: boolean; "aria-haspopup": "dialog" };
		}) => React.ReactNode;
	}) => {
		fixture.permissionOwners++;
		fixture.permissionVisible = detailsOpen;
		return children({
			content: <div>File management body</div>,
			attention: detailsOpen ? null : <p role="alert">Pending file approval</p>,
			contextAction: { disabled: false, "aria-haspopup": "dialog" },
		});
	},
}));
vi.mock("../src/features/tool-packs/index.ts", () => ({
	ToolPacksPanel: ({
		active,
		children,
	}: {
		active: boolean;
		children: (content: React.ReactNode) => React.ReactNode;
	}) => {
		fixture.packOwners++;
		fixture.packActive = active;
		return children(<div>Tool pack management body</div>);
	},
}));
const conversation: Conversation = {
	workspaceId: "workspace",
	conversationId: "conversation",
	title: "Working conversation",
	revision: 1,
	createdAt: 1,
	archivedAt: null,
};
function render() {
	return renderToStaticMarkup(<ConversationCapabilities conversation={conversation} connected />);
}
beforeEach(() => {
	fixture.open = false;
	fixture.section = null;
	fixture.locale = "en";
	fixture.permissionOwners = 0;
	fixture.packOwners = 0;
});
test("acquisition has one plus menu while permissions remain a separate control", () => {
	const html = render();
	assert.match(html, /class="permission-controls capabilities-controls"/);
	assert.match(html, /aria-label="Conversation capabilities"/);
	assert.match(html, /aria-label="Add files and tools"/);
	assert.match(html, /role="menu"/);
	assert.match(html, />Permissions<\/span>/);
	assert.match(html, />File context<\/button>/);
	assert.match(html, />Tools<\/button>/);
	assert.doesNotMatch(html, />Capabilities<\/span>/);
	assert.doesNotMatch(html, /type="file"|Upload|selected tools/);
	assert.match(html, /Pending file approval/);
	assert.doesNotMatch(html, /File management body|Tool pack management body/);
	assert.equal(fixture.permissionOwners, 1);
	assert.equal(fixture.packOwners, 1, "The tool-pack owner remains mounted even while its portalled UI is closed");
	assert.equal(fixture.packActive, false);
});
test("the file section embeds one permission body and does not activate tool-pack reads", () => {
	fixture.open = true;
	fixture.section = "files";
	const html = render();
	assert.match(html, /File access &amp; approvals/);
	assert.doesNotMatch(html, /capabilities-nav/);
	assert.match(html, /File management body/);
	assert.doesNotMatch(html, /Tool pack management body|Pending file approval/);
	assert.equal(fixture.permissionOwners, 1);
	assert.equal(fixture.packOwners, 1);
	assert.equal(fixture.permissionVisible, true);
	assert.equal(fixture.packActive, false);
});
test("tool packs activates only its own read surface while file approval attention stays in the sheet", () => {
	fixture.open = true;
	fixture.section = "tool-packs";
	const html = render();
	assert.match(html, /Tool pack management body/);
	assert.doesNotMatch(html, /File management body/);
	assert.equal((html.match(/Pending file approval/g) ?? []).length, 1);
	assert.doesNotMatch(html, /aria-current="page"/);
	assert.equal(fixture.permissionVisible, false);
	assert.equal(fixture.packActive, true);
});
test("closing from tool packs suspends that surface without removing either management owner", () => {
	fixture.section = null;
	fixture.locale = "zh-CN";
	const html = render();
	assert.match(html, /aria-label="会话能力"/);
	assert.match(html, />权限<\/span>/);
	assert.match(html, /aria-label="添加文件与工具"/);
	assert.match(html, />文件上下文<\/button>/);
	assert.match(html, />工具<\/button>/);
	assert.equal(fixture.permissionOwners, 1);
	assert.equal(fixture.packOwners, 1);
	assert.equal(fixture.permissionVisible, false);
	assert.equal(fixture.packActive, false);
	assert.match(html, /Pending file approval/);
});
