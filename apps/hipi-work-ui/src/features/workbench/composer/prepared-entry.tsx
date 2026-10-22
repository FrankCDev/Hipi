import { LIMITS, type ModelReference } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Settings2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAppClient, useLocalState } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { workbenchLabels } from "../workbench-labels.ts";
import { ComposerEditor, type ComposerEditorHandle } from "./editor.tsx";
import "./prepared-entry.css";

/** Send alone starts work. Opening, editing and choosing a model never create a conversation. */
export function PreparedTaskEntry({
	disabled,
	busy,
	onSend,
	draft,
	onDraftChange,
	onManageModels,
	focusRevision = 0,
	readOnly = false,
}: {
	disabled: boolean;
	busy: boolean;
	onSend: (text: string, model: ModelReference) => Promise<void>;
	draft: string;
	onDraftChange: (value: string) => void;
	onManageModels: (returnFocus: HTMLButtonElement | null) => void;
	focusRevision?: number;
	readOnly?: boolean;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const { t, locale } = usePreferences();
	const input = useRef<ComposerEditorHandle>(null);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const modelSettingsHandoff = useRef(false);
	const sending = useRef(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [modelKey, setModelKey] = useState(() => local.read("new-chat-model") ?? "");
	const [failed, setFailed] = useState(false);
	const inputId = useId();
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
	});
	const currentCatalog = useRef({ catalog, disabled, busy });
	currentCatalog.current = { catalog, disabled, busy };
	const configured = (provider: string) =>
		catalog.data?.providers.some((item) => item.provider === provider && item.credentialState === "configured");
	// A removed selection must not silently redirect the user's next message to another service.
	const selected = modelKey
		? catalog.data?.models.find((model) => JSON.stringify([model.provider, model.modelId]) === modelKey)
		: (catalog.data?.models.find((model) => configured(model.provider)) ?? catalog.data?.models[0]);
	const ready = selected && configured(selected.provider) && !catalog.isError;
	useLayoutEffect(() => {
		if (focusRevision > 0) input.current?.focus();
	}, [focusRevision]);
	const send = () => {
		if (!draft.trim() || !ready || !selected || disabled || busy || sending.current) return;
		sending.current = true;
		setFailed(false);
		const model = { provider: selected.provider, modelId: selected.modelId };
		void onSend(draft, model)
			.catch(() => setFailed(true))
			.finally(() => {
				sending.current = false;
			});
	};
	return (
		<div className="prepared-task-entry">
			<div className="composer new-chat-composer" data-has-draft={draft.length > 0} aria-busy={busy}>
				<form
					id={`${inputId}-form`}
					className="composer-form"
					onSubmit={(event) => {
						event.preventDefault();
						send();
					}}
				>
					<ComposerEditor
						id={inputId}
						ref={input}
						value={draft}
						onChange={onDraftChange}
						onSubmit={send}
						readOnly={readOnly}
						maxLength={LIMITS.text}
						placeholder={t("work.placeholder")}
						label={t("work.draft")}
						describedBy={`${inputId}-hint`}
					/>
				</form>
				<div className="composer-actions">
					<div className="composer-controls new-chat-controls">
						{selected && !configured(selected.provider) && (
							<output className="new-chat-model-warning">
								{t(
									`model.${catalog.data?.providers.find((item) => item.provider === selected.provider)?.credentialState ?? "unavailable"}`,
								)}
							</output>
						)}
						<DropdownMenu
							open={modelOpen}
							onOpenChange={(open) => {
								if (open) modelSettingsHandoff.current = false;
								setModelOpen(open);
							}}
						>
							<DropdownMenuTrigger asChild>
								<Button
									ref={modelTrigger}
									variant="ghost"
									size="sm"
									className="new-chat-model-trigger"
									aria-label={t("model.select")}
									disabled={disabled || busy}
								>
									<span>{selected?.name ?? t(catalog.isPending ? "common.loading" : "model.select")}</span>
									<ChevronDown size={14} aria-hidden="true" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								className="new-chat-model-menu"
								align="start"
								side="top"
								aria-label={t("model.select")}
								onCloseAutoFocus={(event) => {
									if (modelSettingsHandoff.current) event.preventDefault();
								}}
							>
								<DropdownMenuRadioGroup
									value={selected ? JSON.stringify([selected.provider, selected.modelId]) : ""}
									onValueChange={(key) => {
										if (
											disabled ||
											busy ||
											sending.current ||
											catalog.isError ||
											!catalog.data?.models.some((model) => JSON.stringify([model.provider, model.modelId]) === key)
										)
											return;
										setModelKey(key);
										local.write("new-chat-model", key);
										setModelOpen(false);
									}}
								>
									{catalog.data?.models.map((model) => {
										const key = JSON.stringify([model.provider, model.modelId]);
										return (
											<DropdownMenuRadioItem
												key={key}
												value={key}
												textValue={model.name}
												disabled={catalog.isError}
												className="new-chat-model-choice"
											>
												<span className="model-choice-copy">
													<strong>{model.name}</strong>
													<span>
														{catalog.data?.providers.find((item) => item.provider === model.provider)?.name ??
															model.provider}
													</span>
												</span>
											</DropdownMenuRadioItem>
										);
									})}
								</DropdownMenuRadioGroup>
								{(catalog.isError || catalog.data?.models.length === 0) && (
									<p role="alert">{t(catalog.isError ? "model.failed" : "model.empty")}</p>
								)}
								<DropdownMenuSeparator />
								{catalog.isError && (
									<DropdownMenuItem
										className="new-chat-model-retry"
										disabled={disabled || busy || catalog.isFetching}
										onSelect={(event) => {
											event.preventDefault();
											const current = currentCatalog.current;
											if (
												current.disabled ||
												current.busy ||
												sending.current ||
												!current.catalog.isError ||
												current.catalog.isFetching
											)
												return;
											void current.catalog.refetch();
										}}
									>
										<Icon name="refresh" size={15} />
										{t("model.retryRead")}
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									className="new-chat-manage-models"
									onSelect={() => {
										modelSettingsHandoff.current = true;
										setModelOpen(false);
										onManageModels(modelTrigger.current);
									}}
								>
									<Settings2 size={15} aria-hidden="true" />
									{t("model.settings")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<Button
						type="submit"
						form={`${inputId}-form`}
						size="icon"
						className="composer-submit"
						data-action="send"
						disabled={!draft.trim() || !ready || disabled || busy}
						aria-label={t(busy ? "work.sending" : "work.send")}
						title={t(busy ? "work.sending" : "work.send")}
					>
						<Icon name="arrowUp" size={18} />
					</Button>
				</div>
			</div>
			<p className="sr-only" id={`${inputId}-hint`}>
				{t("work.composer.shortcuts")}
			</p>
			{failed && (
				<p className="notice" role="alert">
					{workbenchLabels(locale)["workbench.initialSendUnconfirmed"]}
				</p>
			)}
			{(catalog.isError || (!catalog.isPending && catalog.data?.models.length === 0)) && (
				<p className="notice" role="alert">
					{t(catalog.isError ? "model.failed" : "model.empty")}
				</p>
			)}
			{!local.storageAvailable && <p className="notice">{t("work.draftUnsaved")}</p>}
		</div>
	);
}
