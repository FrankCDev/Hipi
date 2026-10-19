import { createHash, randomUUID } from "node:crypto";
import { type CheckpointInfo, defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import { AppError, type Conversation, type ConversationCommandResult } from "./contracts.ts";

// Replace every 32nd change with a base to bound current-only document replay.
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= 31;

export const DIRECTORY_LIMITS = {
	activeConversations: 100,
	liveConversations: 256,
	pendingReceipts: 64,
	page: 50,
} as const;
export type DirectoryHeader = {
	workspaceId: string;
	name: string;
	generation: string;
	nextOrdinal: number;
	changeSeq: number;
	activeCount: number;
	initialized: boolean;
};
export type ConversationMetadata = Conversation & { durableId: number; ordinal: number };
export const WorkspaceHeaderDoc = defineDoc<DirectoryHeader>({
	kind: "hipi.workspace-directory",
	scope: "session",
	version: 1,
	checkpointWhen,
	initial: () => ({
		workspaceId: "",
		name: "",
		generation: randomUUID(),
		nextOrdinal: 0,
		changeSeq: 0,
		activeCount: 0,
		initialized: false,
	}),
});
export const ConversationMetaDoc = defineDocFamily<{ value?: ConversationMetadata }, null>({
	kind: "hipi.conversation-metadata",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});
export const DirectoryChangeDoc = defineDocFamily<{ publicId: string; revision: number }, null>({
	kind: "hipi.directory-change",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ publicId: "", revision: 0 }),
});
export const DirectoryCommandDoc = defineDocFamily<{ digest?: string; value?: ConversationCommandResult }, null>({
	kind: "hipi.directory-command",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});
export type WorkspaceLive = {
	items: { publicId: string; broker: boolean; receipts: boolean; cancellation: boolean }[];
};
export const WorkspaceLiveDoc = defineDoc<WorkspaceLive>({
	kind: "hipi.workspace-live",
	scope: "session",
	version: 1,
	checkpointWhen,
	initial: () => ({ items: [] }),
});
export const ConversationDeliveryDoc = defineDocFamily<{ keys: string[] }, null>({
	kind: "hipi.conversation-delivery",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({ keys: [] }),
});
export const SubmissionReceiptDoc = defineDocFamily<{ receiptId?: string; requestKey?: string }, null>({
	kind: "hipi.submission-receipt",
	scope: "session",
	version: 1,
	checkpointWhen,
	family: true,
	initial: () => ({}),
});

export function commandKey(workspaceId: string, requestId: string): string {
	return createHash("sha256")
		.update(JSON.stringify(["local-owner", workspaceId, requestId]))
		.digest("hex");
}
export function directoryDigest(method: string, input: object): string {
	return createHash("sha256")
		.update(JSON.stringify([method, input]))
		.digest("hex");
}
export function publicConversation(value: ConversationMetadata): Conversation {
	return {
		workspaceId: value.workspaceId,
		conversationId: value.conversationId,
		title: value.title,
		revision: value.revision,
		createdAt: value.createdAt,
		archivedAt: value.archivedAt,
	};
}
export async function recordDirectoryChange(tx: Tx, value: ConversationMetadata): Promise<void> {
	const header = await tx.doc(WorkspaceHeaderDoc);
	const change = await tx.doc(DirectoryChangeDoc, String(++header.changeSeq), null);
	change.publicId = value.conversationId;
	change.revision = value.revision;
}
export async function assertConversationActive(tx: Tx, publicId: string): Promise<void> {
	const value = (await tx.doc(ConversationMetaDoc, publicId, null)).value;
	if (!value) throw new AppError("NOT_FOUND");
	if (value.archivedAt !== null) throw new AppError("CONVERSATION_ARCHIVED");
}
export async function updateWorkspaceLive(
	tx: Tx,
	publicId: string,
	kind: "broker" | "receipts" | "cancellation",
	active: boolean,
): Promise<void> {
	const live = await tx.doc(WorkspaceLiveDoc);
	const item = live.items.find((entry) => entry.publicId === publicId);
	if (!item && active) {
		if (live.items.length >= DIRECTORY_LIMITS.liveConversations) throw new AppError("CAPACITY_EXCEEDED");
		live.items.push({
			publicId,
			broker: kind === "broker",
			receipts: kind === "receipts",
			cancellation: kind === "cancellation",
		});
		return;
	}
	if (item) item[kind] = active;
	live.items = live.items.filter((entry) => entry.broker || entry.receipts || entry.cancellation);
}
