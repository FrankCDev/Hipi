import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import type { ConversationController } from "./use-conversation.ts";
import { workbenchLabels } from "./workbench-labels.ts";

export function ConversationModelControls({ controller }: { controller: ConversationController }) {
	const { t, locale } = usePreferences();
	const [open, setOpen] = useState(false);
	const { model, execution } = controller;
	const info = model.data;
	return (
		<div className="conversation-model-controls">
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="model-status-trigger"
						aria-label={workbenchLabels(locale)["workbench.modelStatus"]}
					>
						<span>
							{info?.model.modelId ??
								(model.isPending ? t("common.loading") : workbenchLabels(locale)["workbench.modelStatus"])}
						</span>
						<ChevronDown size={14} aria-hidden="true" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="model-status-popover"
					align="start"
					aria-label={workbenchLabels(locale)["workbench.modelStatus"]}
				>
					<div className="grid gap-2 text-sm">
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
						<Button variant="outline" size="sm" disabled={model.isFetching} onClick={() => void model.refetch()}>
							{t("model.refresh")}
						</Button>
						{info && info.executionState !== "ready" && (
							<p className="text-muted-foreground">{t("model.cancelNote")}</p>
						)}
					</div>
				</PopoverContent>
			</Popover>
			{info && info.executionState !== "ready" && (
				<output className="model-state">{t(`model.${info.executionState}`)}</output>
			)}
			{info && info.credentialState !== "configured" && (
				<output className="model-state">{t(`model.${info.credentialState}`)}</output>
			)}
			{model.isError && <p role="alert">{t("model.failed")}</p>}
			{execution.isError && <p role="alert">{t("model.actionFailed")}</p>}
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
					title={t("model.cancelNote")}
				>
					{t("model.cancelExecution")}
				</Button>
			)}
		</div>
	);
}
