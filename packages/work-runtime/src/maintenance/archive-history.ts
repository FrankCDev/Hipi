import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Conversation as PiConversation } from "@earendil-works/pi-durable";
import type { ReadonlySqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AppError, type Conversation, LIMITS, parseResult } from "../contracts.ts";

import { previewMessage, textOf } from "../history.ts";

export async function archiveDocument(storage: ReadonlySqliteStorage, kind: string, key?: string) {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
		"current",
		context,
	);
	const doc = record ? await storage.document(record.id, "current", context) : undefined;
	if (doc && doc.version !== 1) throw new AppError("INDEX_RECOVERY_REQUIRED");
	return doc?.value;
}
export type ArchiveConversation = Conversation & { durableId: number };
/** Rebuild from PI facts, never from the source catalog's disposable projection. */
export async function* archiveConversations(
	storage: ReadonlySqliteStorage,
	workspaceId: string,
): AsyncGenerator<ArchiveConversation> {
	const header = await archiveDocument(storage, "hipi.workspace-directory");
	if (header?.initialized === true) {
		let cursor: Cursor | undefined;
		let count = 0;
		do {
			const page = await storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current", kind: "hipi.conversation-metadata" },
				50,
				cursor,
				context,
			);
			for (const record of page.items) {
				const doc = await storage.document(record.id, "current", context);
				const value = doc?.value.value;
				if (doc?.version !== 1 || !value || typeof value !== "object" || Array.isArray(value))
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				const conversation = parseResult("getConversation", {
					workspaceId: value.workspaceId,
					conversationId: value.conversationId,
					title: value.title,
					revision: value.revision,
					createdAt: value.createdAt,
					archivedAt: value.archivedAt,
				});
				if (
					conversation.workspaceId !== workspaceId ||
					conversation.conversationId !== record.key ||
					typeof value.durableId !== "number" ||
					!Number.isSafeInteger(value.durableId) ||
					value.durableId < 1 ||
					!(await storage.conversation(value.durableId as ConversationId, context))
				)
					throw new AppError("INDEX_RECOVERY_REQUIRED");
				count++;
				yield { ...conversation, durableId: value.durableId };
			}
			cursor = page.next;
		} while (cursor);
		if (count !== header.nextOrdinal) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return;
	}
	const legacy = await archiveDocument(storage, "hipi.workspace");
	if (
		!legacy ||
		legacy.workspaceId !== workspaceId ||
		!Array.isArray(legacy.conversations) ||
		legacy.conversations.length > 16
	)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	for (const item of legacy.conversations) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			typeof item.durableId !== "number" ||
			!Number.isSafeInteger(item.durableId) ||
			item.durableId < 1 ||
			!(await storage.conversation(item.durableId as ConversationId, context))
		)
			throw new AppError("INDEX_RECOVERY_REQUIRED");
		yield {
			...parseResult("getConversation", {
				workspaceId,
				conversationId: item.publicId,
				title: item.title,
				revision: 1,
				createdAt: null,
				archivedAt: null,
			}),
			durableId: item.durableId,
		};
	}
}
export function archiveEntries(storage: ReadonlySqliteStorage, durableId: number): Pick<PiConversation, "entries"> {
	return {
		entries: (query, limit, cursor, ctx) =>
			storage.scanEntries({ ...query, conversationId: durableId as ConversationId }, limit, cursor, ctx),
	};
}

/** Ascending fork-aware scans keep export globally chronological without buffering old pages. */
export async function* archiveMessages(storage: ReadonlySqliteStorage, durableId: number) {
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(
			{ conversationId: durableId as ConversationId, order: "ascending" },
			LIMITS.historyScanEntries,
			cursor,
			context,
		);
		for (const entry of page.items) {
			for (let index = 0; index < (entry.model?.length ?? 0); index++) {
				const message = previewMessage(entry, index);
				const model = entry.model?.[index];
				if (message && model) yield { message, text: textOf(model) };
			}
		}
		cursor = page.next;
	} while (cursor);
}
