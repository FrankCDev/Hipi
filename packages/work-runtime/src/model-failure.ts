/** Fixed diagnostic vocabulary only. Provider text, response bodies and URLs are never public evidence. */
export const MODEL_FAILURE_CATEGORIES = [
	"model_request_failed",
	"model_auth_failed",
	"model_rate_limited",
	"model_network_failed",
	"model_unavailable",
	"model_request_rejected",
	"model_service_unavailable",
	"model_context_blocked",
	"credential_required",
	"credential_locked",
	"credential_unavailable",
] as const;
export type ModelFailureCategory = (typeof MODEL_FAILURE_CATEGORIES)[number];
export type ModelFailure = {
	category: ModelFailureCategory;
	/** attempted confirms only dispatch, never service execution, billing or rollback. */
	dispatch: "not_sent" | "attempted" | "unknown";
};
export function modelFailureCategory(value: unknown): ModelFailureCategory | undefined {
	return MODEL_FAILURE_CATEGORIES.find((category) => category === value);
}
export function modelFailureDetail(category: ModelFailureCategory, dispatch: ModelFailure["dispatch"]): string {
	return `hipi_model_failure:${category}:${dispatch}`;
}
/** Durable retains this bounded marker as submission detail. Older plain category markers remain readable. */
export function readModelFailureDetail(value: unknown): ModelFailure | undefined {
	if (typeof value !== "string" || value.length > 128) return undefined;
	const legacy = modelFailureCategory(value);
	if (legacy) return { category: legacy, dispatch: "unknown" };
	const parts = value.split(":");
	if (parts.length !== 3 || parts[0] !== "hipi_model_failure") return undefined;
	const category = modelFailureCategory(parts[1]);
	const dispatch = parts[2];
	return category && (dispatch === "not_sent" || dispatch === "attempted" || dispatch === "unknown")
		? { category, dispatch }
		: undefined;
}
