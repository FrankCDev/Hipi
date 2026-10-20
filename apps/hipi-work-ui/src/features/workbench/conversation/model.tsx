import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../../components/ui/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.tsx";
import { workbenchLabels } from "../workbench-labels.ts";
import type { ConversationController } from "./use-conversation.ts";

export function ConversationModelControls({
	controller,
	onOpenModelSettings,
}: {
	controller: ConversationController;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
}) {
	const { t, locale } = usePreferences();
	const client = useAppClient();
	const [open, setOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const modelSettingsHandoff = useRef(false);
	const { model, execution } = controller;
	const info = model.data;
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
	});
	const modelName = catalog.data?.models.find(
		(item) => item.provider === info?.model.provider && item.modelId === info.model.modelId,
	)?.name;
	const providerName = catalog.data?.providers.find((item) => item.provider === info?.model.provider)?.name;
	return (
		<div className="conversation-model-controls" data-execution-state={info?.executionState}>
			<Popover
				open={modelOpen}
				onOpenChange={(value) => {
					if (value) modelSettingsHandoff.current = false;
					setModelOpen(value);
				}}
			>
				<PopoverTrigger asChild>
					<Button
						ref={modelTrigger}
						variant="ghost"
						size="sm"
						className="model-status-trigger"
						aria-label={workbenchLabels(locale)["workbench.modelStatus"]}
					>
						<span>
							{modelName ??
								info?.model.modelId ??
								(model.isPending ? t("common.loading") : workbenchLabels(locale)["workbench.modelStatus"])}
						</span>
						<ChevronDown size={14} aria-hidden="true" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="model-status-popover"
					align="start"
					aria-label={workbenchLabels(locale)["workbench.modelStatus"]}
					onCloseAutoFocus={(event) => {
						if (modelSettingsHandoff.current) event.preventDefault();
					}}
				>
					<div className="grid gap-2 text-sm">
						{info && (
							<>
								<span className="break-all">
									{providerName ? `${providerName} · ` : ""}
									{info.model.modelId}
								</span>
								<output>
									{t(`model.${info.credentialState}`)} · {t(`model.${info.executionState}`)}
								</output>
								<p className="text-muted-foreground">{t("model.fixed")}</p>
							</>
						)}
						{model.isPending && <output>{t("common.loading")}</output>}
						{info && info.credentialState !== "configured" && onOpenModelSettings && (
							<Button
								variant="outline"
								size="sm"
								className="conversation-manage-models"
								onClick={() => {
									if (!modelTrigger.current) return;
									modelSettingsHandoff.current = true;
									setModelOpen(false);
									onOpenModelSettings(modelTrigger.current);
								}}
							>
								{t("model.settings")}
							</Button>
						)}
						<Button variant="outline" size="sm" disabled={model.isFetching} onClick={() => void model.refetch()}>
							{t("model.refresh")}
						</Button>
						{info && info.executionState !== "ready" && (
							<p className="text-muted-foreground">{t("model.cancelNote")}</p>
						)}
					</div>
				</PopoverContent>
			</Popover>
			{info && info.executionState !== "ready" && info.executionState !== "running" && (
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
			{info?.executionState === "paused" && (
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
