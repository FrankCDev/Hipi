import type { ConversationModel } from "@hipi/work-runtime/contracts";
/** Fail closed while status is unknown, stale after error, or awaiting whole-workspace authorization. */
export function canExecuteModel(model: ConversationModel | undefined, failed: boolean): boolean {
	return !failed && model?.credentialState === "configured" && model.executionState === "ready";
}
