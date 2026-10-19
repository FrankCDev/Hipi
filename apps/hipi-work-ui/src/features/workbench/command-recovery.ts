import { parseRequest, type Request } from "@hipi/work-runtime/contracts";
import type { LocalState } from "./local-state.ts";

export type CatalogCommand = Extract<
	Request,
	{
		method:
			| "createWorkspace"
			| "createConversation"
			| "renameConversation"
			| "archiveConversation"
			| "restoreConversation";
	}
>;
export type AgentCommand = Extract<
	Request,
	{ method: "authorizeAgentContext" | "authorizeRetainedContext" | "revokeAgentContext" | "decideToolApproval" }
>;
export type RecoverableCommand = CatalogCommand | AgentCommand;
export type RecoveryRecord = { request: RecoverableCommand | null; incompatible: boolean };

/** Version 2 command payloads are separate from v1 drafts and pending message submissions. */
export function readCommand(local: LocalState | undefined, key: string): RecoveryRecord {
	const raw = local?.read(`command.${key}`);
	if (!raw) return { request: null, incompatible: false };
	try {
		const saved: unknown = JSON.parse(raw);
		if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 2 || !("request" in saved))
			throw new Error("INCOMPATIBLE_RECOVERY");
		if (saved.request === null) return { request: null, incompatible: false };
		if (!saved.request || typeof saved.request !== "object") throw new Error("INVALID_RECOVERY");
		const request = parseRequest(saved.request);
		if (request.expectedStoreId !== undefined) throw new Error("INVALID_RECOVERY");
		if (
			request.method === "createWorkspace" ||
			request.method === "createConversation" ||
			request.method === "renameConversation" ||
			request.method === "archiveConversation" ||
			request.method === "restoreConversation" ||
			request.method === "authorizeAgentContext" ||
			request.method === "authorizeRetainedContext" ||
			request.method === "revokeAgentContext" ||
			request.method === "decideToolApproval"
		)
			return { request, incompatible: false };
	} catch {
		/* Keep unrecognized original records untouched; never invent missing request IDs. */
	}
	return { request: null, incompatible: true };
}
export function saveCommand(local: LocalState | undefined, key: string, request: RecoverableCommand | null) {
	if (local && !local.write(`command.${key}`, JSON.stringify({ version: 2, request })))
		throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
}
