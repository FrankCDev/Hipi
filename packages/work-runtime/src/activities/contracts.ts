import type { FileOperationStatus, Scope, ToolApprovalStatus } from "../contracts.ts";

export const ACTIVITY_LIMITS = {
	page: 16,
	textBytes: 8192,
	hydrationBytes: 2097152,
	summaryItems: 16,
	summaryBytes: 8192,
	taskIds: 16,
	parentEdges: 16,
	taskHydrations: 64,
} as const;

export type MessageToolCalls = {
	items: { contentIndex: number; callId: string; name: string }[];
	/** Includes calls omitted by identity or serialized-byte limits. */
	total: number;
};
export type ToolActivitySelector =
	| { kind: "tasks"; taskIds: string[] }
	| { kind: "message"; messageId: string; contentIndex?: number };

export type ToolActivity = {
	activityId: string;
	taskId?: string;
	callId: string;
	toolName: string;
	source: "task" | "entry";
	inherited: boolean;
	anchor?: { assistantEntryId: string; modelIndex: number; contentIndex: number };
	phase: "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal" | "unavailable";
	outcome?: "completed" | "failed" | "aborted" | "orphaned" | "faulted";
	toolResult: "success" | "error" | "unavailable";
	abortRequested: boolean;
	parentTaskId?: string;
	resultEntryId?: string;
	startedAt?: number;
	endedAt?: number;
	receiptIds: string[];
	approval?: { approvalId: string; status: ToolApprovalStatus; grantId: string; expired: boolean };
	effect?: { operationId: string; status: FileOperationStatus };
	artifact?: {
		rootId: string;
		path: string;
		operationId: string;
		status: FileOperationStatus;
		expectedRevision?: string;
	};
	textAvailable: boolean;
	outputTruncated: boolean;
};

/** Default: two scan sections. Message: filtered task scan. Exact: finite selection, never a state snapshot. */
export type ToolActivityPage = {
	items: ToolActivity[];
	/** Exact selection only. Echoed requested IDs, without disclosing why evidence is unavailable. */
	unavailableTaskIds?: string[];
	nextCursor: string | null;
	coverage: "tasks" | "entries";
	membershipFence: string;
};
export type ToolActivityTextPage = {
	activityId: string;
	text: string;
	nextCursor: string | null;
	/** Only persisted tool output is returned, whether or not upstream truncated it. */
	retainedOutputOnly: true;
};
export type ActivityReadScope = Scope & { durableId: number; generation: string; storeId: string };
