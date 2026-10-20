import type { Conversation, ConversationFilter } from "../contracts.ts";
import type { ConversationMembership, ProjectId } from "../projects/contracts.ts";

export const NAVIGATION_LIMITS = { page: 50, candidates: 128, tasks: 32, entries: 32, slots: 256 } as const;
export const ACTIVITY_BASES = [
	"accepted",
	"generation_started",
	"generation_terminal",
	"message",
	"creation",
	"unknown",
] as const;
export type ActivityBasis = (typeof ACTIVITY_BASES)[number];
/** Trusted adapter commit facts, never renderer-authored mutation input. */
export type NavigationInvalidation = {
	conversations: { conversation: Conversation; generation: string; durableId: number }[];
	reset: boolean;
};
export type SidebarView =
	| { kind: "recent" }
	/** Logical recent conversations, excluding individual pins and members of pinned projects. */
	| { kind: "project_recent" }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "project"; projectId: ProjectId | null };
export type SidebarCoverage = {
	generation: string;
	/** Authoritative pin membership only; pure pin ordering does not change this value. */
	membershipGeneration: number;
	/** Present on logical project views, independent of conversation pins. */
	projectMembershipGeneration?: number;
	/** Logical project pin/order fence; absent on legacy physical views. */
	projectOrderGeneration?: number;
	state: "building" | "refreshing" | "ready";
	/** Last verified traversal, not activity time or a cross-database atomic snapshot. */
	completedAt: number | null;
	nextCursor: string | null;
};
export type SidebarConversation = {
	conversation: Conversation;
	/** Required for logical views. Canonical execution identity remains the conversation's Scope. */
	membership?: ConversationMembership;
	recencyAt: number | null;
	activityBasis: ActivityBasis;
};
export type SidebarPage = {
	items: SidebarConversation[];
	coverage: SidebarCoverage;
	nextCursor: string | null;
};
export type NavigationMethods = {
	refreshSidebarProjection: { params: { cursor?: string }; result: SidebarCoverage };
	listSidebarConversations: {
		params: { view: SidebarView; filter?: ConversationFilter; cursor?: string };
		result: SidebarPage;
	};
};
