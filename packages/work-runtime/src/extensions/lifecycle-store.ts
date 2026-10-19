import { createHash } from "node:crypto";
import { type CheckpointInfo, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ToolPackBinding, ToolPackCommandResult, ToolPackRecord } from "./contracts.ts";

// Keep current-only materialization to at most 31 deltas; business records and audit documents remain intact.
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= 31;

/** PI documents are the sole authority. Retired packages retain their exact installation text. */
export const PackDoc = defineDocFamily<{ value?: ToolPackRecord; packageText?: string; interpreterVersion: 1 }, null>({
	kind: "hipi.tool-pack",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({ interpreterVersion: 1 }),
	checkpointWhen,
});
export const PackIdentityDoc = defineDocFamily<{ digest?: string }, null>({
	kind: "hipi.tool-pack-identity",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({}),
	checkpointWhen,
});
export const PackHeaderDoc = defineDoc<{ count: number; enabled: string[]; live: number[] }>({
	kind: "hipi.tool-pack-header",
	scope: "session",
	version: 1,
	initial: () => ({ count: 0, enabled: [], live: [] }),
	checkpointWhen,
});
export const PackBindingDoc = defineDocFamily<{ conversationId: number; value?: ToolPackBinding }, null>({
	kind: "hipi.tool-pack-binding",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({ conversationId: 0 }),
	checkpointWhen,
});
export const PackConversationDoc = defineDocFamily<
	{
		publicId: string;
		active: string[];
		dependencies: string[];
		count: number;
	},
	null
>({
	kind: "hipi.tool-pack-conversation",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({ publicId: "", active: [], dependencies: [], count: 0 }),
	checkpointWhen,
});
export const PackAuditDoc = defineDocFamily<{ ids: string[] }, null>({
	kind: "hipi.tool-pack-audit",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({ ids: [] }),
	checkpointWhen,
});
export const PackCommandDoc = defineDocFamily<{ value?: ToolPackCommandResult; resultId?: string }, null>({
	kind: "hipi.tool-pack-command",
	scope: "session",
	version: 1,
	family: true,
	initial: () => ({}),
	checkpointWhen,
});
export const packCommandKey = (workspaceId: string, requestId: string) =>
	createHash("sha256")
		.update(JSON.stringify([1, workspaceId, requestId]))
		.digest("hex");
export const packIdentityKey = (packageId: string, version: string) =>
	createHash("sha256")
		.update(JSON.stringify([1, packageId, version]))
		.digest("hex");
