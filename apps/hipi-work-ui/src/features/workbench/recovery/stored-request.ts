import { PROTOCOL_VERSION, parseRequest, type Request } from "@hipi/work-runtime/contracts";

// Protocol 8 published schemas match these protocol 9 commands exactly. This is a
// local journal decoder, never a transport compatibility rule or replay authority.
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
		(value.version !== PROTOCOL_VERSION && !(PROTOCOL_VERSION === 9 && value.version === 8)) ||
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
