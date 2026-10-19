const messages = {
	"receipt.outcome.aborted": [
		"上一次任务已请求取消。已产生的费用或文件修改不会因此回滚。",
		"Cancellation was requested for the previous task. Existing charges or file changes are not rolled back.",
	],
	"receipt.outcome.reset": [
		"上一次任务因会话重置而结束，请核对已有成果后再提交。",
		"The previous task ended after a conversation reset. Review existing results before submitting again.",
	],
	"receipt.outcome.noModel": [
		"上一次任务没有可用模型，请检查模型设置。",
		"No model was available for the previous task. Check model settings.",
	],
	"receipt.outcome.modelError": [
		"上一次模型请求未完成，请检查模型设置与会话授权。外部请求可能已经发生，请勿盲目重试。",
		"The previous model request did not complete. Check model settings and conversation authorization. An external request may already have occurred; do not retry blindly.",
	],
	"receipt.outcome.unknown": [
		"上一次任务没有已确认的回答。请核对执行记录及文件成果，再决定是否重新提交。",
		"The previous task has no confirmed answer. Review its execution record and file results before deciding whether to submit again.",
	],
} as const;

/** PI reason strings are untrusted diagnostics; only known categories become user-facing prose. */
export function executionOutcome(reason: string | undefined, locale: string): string {
	const key =
		reason === "aborted"
			? "receipt.outcome.aborted"
			: reason === "reset"
				? "receipt.outcome.reset"
				: reason === "no_model"
					? "receipt.outcome.noModel"
					: reason === "model_error"
						? "receipt.outcome.modelError"
						: "receipt.outcome.unknown";
	return messages[key][locale === "en" ? 1 : 0];
}
