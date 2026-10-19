import { useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import type { ConversationController } from "./use-conversation.ts";

export function ConversationModelControls({ controller }: { controller: ConversationController }) {
	const { t } = usePreferences();
	const [open, setOpen] = useState(false);
	const { model, execution } = controller;
	const info = model.data;
	return (
		<div className="border-b border-border px-4 py-2 text-sm grid gap-2">
			{info && (
				<>
					<span className="break-all">
						{info.model.provider} · {info.model.modelId}
					</span>
					<output>
						{t(`model.${info.credentialState}`)} · {t(`model.${info.executionState}`)}
					</output>
				</>
			)}
			{model.isPending && <output>{t("common.loading")}</output>}
			{model.isError && <p role="alert">{t("model.failed")}</p>}
			{execution.isError && <p role="alert">{t("model.actionFailed")}</p>}
			<div className="flex flex-wrap gap-2">
				<Button variant="ghost" size="sm" disabled={model.isFetching} onClick={() => void model.refetch()}>
					{t("model.refresh")}
				</Button>
				{(info?.executionState === "paused" || info?.executionState === "cancellation_pending") && (
					<Dialog
						open={open}
						onOpenChange={(value) => {
							if (!execution.isPending) setOpen(value);
						}}
					>
						<DialogTrigger asChild>
							<Button variant="outline" size="sm">
								{t("model.resume")}
							</Button>
						</DialogTrigger>
						<DialogContent closeLabel={t("common.close")} closeDisabled={execution.isPending}>
							<DialogTitle>{t("model.resume")}</DialogTitle>
							<DialogDescription>{t("model.resumeNote")}</DialogDescription>
							<p>{controller.workspaceId}</p>
							<Button
								disabled={execution.isPending || info.credentialState !== "configured" || model.isError}
								onClick={() => execution.mutate("resume", { onSuccess: () => setOpen(false) })}
							>
								{t("model.resume")}
							</Button>
							{execution.isError && <p role="alert">{t("model.actionFailed")}</p>}
						</DialogContent>
					</Dialog>
				)}
				{(info?.executionState === "running" || info?.executionState === "paused") && (
					<Button
						variant="outline"
						size="sm"
						disabled={execution.isPending || model.isError}
						onClick={() => execution.mutate("cancel")}
					>
						{t("model.cancelExecution")}
					</Button>
				)}
			</div>
			{info?.executionState !== "ready" && <p className="text-muted-foreground">{t("model.cancelNote")}</p>}
		</div>
	);
}
