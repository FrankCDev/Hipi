import { PROTOCOL_VERSION, parseRequest, type Request } from "@hipi/work-runtime/contracts";

// Protocols 8, 9 and 10 schemas match these protocol 11 commands exactly.
// Preserve pending data recovery only: this local journal decoder is never a
// transport compatibility rule or replay authority. Re-audit on the next bump.
const storedMethods = new Set([
	"createWorkspace",
	"createConversation",
	"renameConversation",
	"archiveConversation",
	"restoreConversation",
	"authorizeAgentContext",
	"authorizeRetainedContext",
	"revokeAgentContext",
	"decideToolApproval",
	"setConversationPinned",
	"reorderPinnedConversation",
	"setToolPackEnabled",
	"uninstallToolPack",
	"bindToolPack",
	"revokeToolPackBinding",
	"authorizeRetainedToolPack",
]);

/** Decode in memory only; the original journal remains untouched until its owned transition. */
export function parseStoredRequest(value: unknown): Request {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("version" in value) ||
		(value.version !== PROTOCOL_VERSION &&
			!(PROTOCOL_VERSION === 11 && (value.version === 8 || value.version === 9 || value.version === 10))) ||
		!("method" in value) ||
		typeof value.method !== "string" ||
		!storedMethods.has(value.method) ||
		Object.keys(value).some((key) => !["version", "method", "params"].includes(key))
	)
		throw new Error("INCOMPATIBLE_STORED_REQUEST");
	// Only the envelope version changes. The strict parser retains the same schema,
	// parameter ordering and request identity used by the original command digest.
	return parseRequest({ ...value, version: PROTOCOL_VERSION });
}
