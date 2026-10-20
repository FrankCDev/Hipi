import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, Storage } from "@earendil-works/pi-durable";
import { AppError, type Conversation } from "../contracts.ts";
import { ACTIVITY_BASES, type ActivityBasis, NAVIGATION_LIMITS } from "./contracts.ts";

export type NavigationSource = {
	generation: string;
	durableId: number;
	revision: number;
	title: string;
	archived: boolean;
	unversioned?: string;
};
export type ActivityPosition = {
	source: string;
	phase: "tasks" | "messages";
	cursor?: Cursor;
	entry: number;
	slot: number;
	upper: number;
	recencyAt: number | null;
	basis: ActivityBasis;
	execution: boolean;
};
function time(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function include(position: ActivityPosition, value: unknown, basis: ActivityBasis) {
	const at = time(value);
	if (at !== null && (position.recencyAt === null || at > position.recencyAt)) {
		position.recencyAt = at;
		position.basis = basis;
	}
}
/** Public Storage reads only. Whole entry/task materialization is an upstream byte-bound limitation. */
export async function readActivityStep(
	storage: Storage,
	source: NavigationSource,
	conversation: Conversation,
	prior?: ActivityPosition,
	signal?: AbortSignal,
): Promise<{ position: ActivityPosition; complete: boolean; unversioned?: true }> {
	const check = () => {
		if (signal?.aborted) throw new AppError("CLOSED");
	};
	check();
	if (
		source.revision !== conversation.revision ||
		source.title !== conversation.title ||
		source.archived !== (conversation.archivedAt !== null)
	)
		throw new AppError("CURSOR_STALE");
	const identity = JSON.stringify([source.unversioned ?? source.generation, source.durableId]);
	if (
		prior &&
		(Object.keys(prior).some(
			(key) =>
				!["source", "phase", "cursor", "entry", "slot", "upper", "recencyAt", "basis", "execution"].includes(key),
		) ||
			(prior.phase !== "tasks" && prior.phase !== "messages") ||
			typeof prior.execution !== "boolean" ||
			!ACTIVITY_BASES.includes(prior.basis) ||
			[prior.entry, prior.slot, prior.upper].some((value) => time(value) === null) ||
			(prior.recencyAt !== null && time(prior.recencyAt) === null) ||
			(prior.recencyAt === null) !== (prior.basis === "unknown") ||
			(prior.cursor !== undefined &&
				(!prior.cursor || typeof prior.cursor !== "object" || Array.isArray(prior.cursor))))
	)
		throw new AppError("INDEX_RECOVERY_REQUIRED");
	if (prior && prior.source !== identity) throw new AppError("CURSOR_STALE");
	const position: ActivityPosition = prior
		? { ...prior }
		: {
				source: identity,
				phase: "tasks",
				entry: 0,
				slot: 0,
				upper: 0,
				recencyAt: null,
				basis: "unknown",
				execution: false,
			};
	const conversationId = source.durableId as ConversationId;
	if (source.unversioned)
		return { position: { ...position, recencyAt: null, basis: "unknown" }, complete: true, unversioned: true };
	if (!prior) {
		const record = await storage.findDocument(
			{ kind: "hipi.conversation-activity", scope: { kind: "session" }, key: conversation.conversationId },
			"current",
			context,
		);
		if (record) {
			const doc = await storage.document(record.id, "current", context);
			if (
				!doc ||
				doc.version !== 1 ||
				(doc.value.latestAcceptedAt !== null && time(doc.value.latestAcceptedAt) === null)
			)
				throw new AppError("INDEX_RECOVERY_REQUIRED");
			include(position, doc.value.latestAcceptedAt, "accepted");
			position.execution = position.recencyAt !== null;
		}
	}
	if (position.phase === "tasks") {
		const page = await storage.scanTasks(
			{ conversationId, kind: "pi.generation", order: "ascending" },
			NAVIGATION_LIMITS.tasks,
			position.cursor,
			context,
		);
		check();
		for (const task of page.items) {
			if (task.conversationId !== conversationId || task.kind !== "pi.generation")
				throw new AppError("STORE_MISMATCH");
			include(position, task.startedAt, "generation_started");
			if (task.state.status === "terminal") include(position, task.endedAt, "generation_terminal");
		}
		position.execution = position.recencyAt !== null;
		if (page.next) return { position: { ...position, cursor: page.next }, complete: false };
		delete position.cursor;
		if (position.execution) return { position, complete: true };
		position.phase = "messages";
		const newest = await storage.scanEntries({ conversationId, order: "descending" }, 1, undefined, context);
		position.upper = newest.items[0]?.id ?? 0;
	}
	let entries = 0,
		slots = 0;
	while (position.upper > 0 && entries < NAVIGATION_LIMITS.entries && slots < NAVIGATION_LIMITS.slots) {
		check();
		const page = await storage.scanEntries(
			{
				conversationId,
				minEntryId: Math.max(1, position.entry) as EntryId,
				maxEntryId: position.upper as EntryId,
				order: "ascending",
			},
			1,
			undefined,
			context,
		);
		check();
		const entry = page.items[0];
		if (!entry) break;
		entries++;
		if (position.slot > 0 && entry.id !== position.entry) throw new AppError("CURSOR_STALE");
		if (entry.id !== position.entry) position.slot = 0;
		position.entry = entry.id;
		const model = entry.model ?? [];
		if (position.slot > model.length) throw new AppError("CURSOR_STALE");
		while (position.slot < model.length && slots < NAVIGATION_LIMITS.slots) {
			const message = model[position.slot++];
			slots++;
			if (message.role === "user" || message.role === "assistant") include(position, message.timestamp, "message");
		}
		if (position.slot < model.length) return { position, complete: false };
		position.entry = entry.id + 1;
		position.slot = 0;
		if (entry.id >= position.upper) break;
	}
	if (
		position.upper > 0 &&
		position.entry <= position.upper &&
		(entries === NAVIGATION_LIMITS.entries || slots === NAVIGATION_LIMITS.slots)
	)
		return { position, complete: false };
	if (position.recencyAt === null) include(position, conversation.createdAt, "creation");
	return { position, complete: true };
}
