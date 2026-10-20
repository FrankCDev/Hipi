import type { ReceiptView, Scope, Snapshot } from "@hipi/work-runtime/contracts";

export type ConversationFailure = {
	key: string;
	modelFailure: ReceiptView["modelFailure"];
};

/** Small request/tail metadata only. Never retain message text or provider diagnostics. */
export class ConversationFailureTracker {
	private readonly requests = new Map<string, { tail: string | undefined; retired: boolean }>();

	observe(
		scope: Scope,
		requestId: string,
		receipt: ReceiptView | null | undefined,
		snapshot: Snapshot | undefined,
		submitting: boolean,
	): ConversationFailure | undefined {
		const key = JSON.stringify([scope.workspaceId, scope.conversationId, requestId]);
		const previous = this.requests.get(key);
		const tail = snapshot?.messages.at(-1)?.id;
		if (previous && (submitting || snapshot?.running || snapshot?.partial || (snapshot && tail !== previous.tail)))
			previous.retired = true;
		if (previous?.retired) return undefined;
		const failure = currentConversationFailure(scope, requestId, receipt, snapshot, submitting);
		if (failure && !previous) {
			this.requests.set(key, { tail, retired: false });
			while (this.requests.size > 64) {
				const oldest = this.requests.keys().next().value;
				if (oldest === undefined) break;
				this.requests.delete(oldest);
			}
		}
		return failure;
	}
}

const trackers = new WeakMap<object, ConversationFailureTracker>();
/** Revisit within one verified client preserves the fence; another client never inherits it. */
export function conversationFailureTrackerFor(client: object): ConversationFailureTracker {
	let tracker = trackers.get(client);
	if (!tracker) {
		tracker = new ConversationFailureTracker();
		trackers.set(client, tracker);
	}
	return tracker;
}

/** A receipt identifies a request, not a transcript message or PI submission entry. */
export function currentConversationFailure(
	scope: Scope,
	requestId: string,
	receipt: ReceiptView | null | undefined,
	snapshot: Snapshot | undefined,
	submitting: boolean,
): ConversationFailure | undefined {
	if (
		!requestId ||
		!receipt ||
		submitting ||
		!snapshot ||
		snapshot.running ||
		snapshot.partial ||
		receipt.requestId !== requestId ||
		receipt.workspaceId !== scope.workspaceId ||
		receipt.conversationId !== scope.conversationId ||
		snapshot.workspaceId !== scope.workspaceId ||
		snapshot.conversationId !== scope.conversationId ||
		receipt.execution !== "unanswered" ||
		receipt.state === "cancelled" ||
		receipt.state === "reconciliation_required" ||
		receipt.reason !== "model_error"
	)
		return undefined;
	return {
		key: `request-failure:${JSON.stringify([scope.workspaceId, scope.conversationId, requestId, receipt.receiptId])}`,
		modelFailure: receipt.modelFailure,
	};
}

const categoryCopy = {
	model_request_failed: ["模型请求未完成。", "The model request did not complete."],
	model_auth_failed: [
		"模型服务拒绝了身份验证，请检查凭据。",
		"The model service rejected authentication. Check its credentials.",
	],
	model_rate_limited: ["模型服务暂时限制了请求。", "The model service temporarily limited requests."],
	model_network_failed: [
		"未能完成与模型服务的连接，请检查网络及服务地址。",
		"The connection to the model service did not complete. Check the network and service URL.",
	],
	model_unavailable: [
		"模型或服务地址不可用，请检查模型设置。",
		"The model or service endpoint is unavailable. Check model settings.",
	],
	model_request_rejected: [
		"模型服务拒绝了此请求，请检查模型设置。",
		"The model service rejected this request. Check model settings.",
	],
	model_service_unavailable: ["模型服务暂时不可用。", "The model service is temporarily unavailable."],
	model_context_blocked: [
		"此请求缺少所需的会话授权，请检查权限设置。",
		"This request needs conversation authorization. Check permissions.",
	],
	credential_required: [
		"尚未配置模型凭据，请在模型设置中添加。",
		"Model credentials are missing. Add them in model settings.",
	],
	credential_locked: ["模型凭据当前已锁定，请检查凭据状态。", "Model credentials are locked. Check their status."],
	credential_unavailable: [
		"模型凭据当前不可用，请检查模型设置。",
		"Model credentials are unavailable. Check model settings.",
	],
} as const;

/** Never interpolate provider diagnostics, endpoints, paths or credential values. */
export function conversationFailureCopy(failure: ConversationFailure, locale: string) {
	const language = locale === "en" ? 1 : 0;
	const category = failure.modelFailure?.category;
	const copy =
		category && Object.hasOwn(categoryCopy, category) ? categoryCopy[category] : categoryCopy.model_request_failed;
	const dispatch = failure.modelFailure?.dispatch;
	return {
		title: language ? "Request not completed" : "请求未完成",
		message: copy[language],
		detail:
			dispatch === "not_sent"
				? language
					? "The request was not sent to the model service."
					: "请求未发送至模型服务。"
				: dispatch === "attempted"
					? language
						? "Sending was attempted. Review existing results before submitting again."
						: "已尝试发送请求。请先核对已有结果，避免重复提交。"
					: language
						? "It is not confirmed whether the request was sent. Review existing results before submitting again."
						: "尚无法确认请求是否已发送。请先核对已有结果，避免重复提交。",
		settings: language ? "Model settings" : "模型设置",
	};
}
