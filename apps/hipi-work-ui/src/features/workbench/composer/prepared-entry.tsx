import { LIMITS, type ModelReference } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Settings2, ShieldCheck } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useAppClient, useFiles, useLocalState } from "../../../app/client-provider.tsx";
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
import type { StagedProjectConsent } from "../catalog/initial-context.ts";
import { useProjectFolder } from "../projects/use-folder.ts";
import { workbenchLabels } from "../workbench-labels.ts";
import { ComposerEditor, type ComposerEditorHandle } from "./editor.tsx";
import { PreparedProjectConsent, preparedContextCurrent } from "./project-consent.tsx";
import { preparedProjectConsentLabels } from "./project-consent-labels.ts";
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
	workspaceId = "",
	readOnly = false,
}: {
	disabled: boolean;
	busy: boolean;
	onSend: (text: string, model: ModelReference, context?: StagedProjectConsent) => Promise<void>;
	draft: string;
	onDraftChange: (value: string) => void;
	onManageModels: (returnFocus: HTMLButtonElement | null) => void;
	focusRevision?: number;
	workspaceId?: string;
	readOnly?: boolean;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const { fileAuthority } = useFiles();
	const { t, locale } = usePreferences();
	const input = useRef<ComposerEditorHandle>(null);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const modelSettingsHandoff = useRef(false);
	const sending = useRef(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [modelKey, setModelKey] = useState(() => local.read("new-chat-model") ?? "");
	const [failed, setFailed] = useState(false);
	const [context, setContext] = useState<StagedProjectConsent>();
	const contextRef = useRef(context);
	const contextOwner = useRef({ client, local, fileAuthority });
	const [consentOpen, setConsentOpen] = useState(false);
	const [contextChanged, setContextChanged] = useState(false);
	const consentTrigger = useRef<HTMLButtonElement>(null);
	const project = useProjectFolder(workspaceId);
	const consentLabels = preparedProjectConsentLabels(locale);
	const changeContext = (value: StagedProjectConsent | undefined) => {
		contextRef.current = value;
		contextOwner.current = { client, local, fileAuthority };
		setContext(value);
		setContextChanged(false);
	};
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
	useEffect(() => {
		if (!context) return;
		const invalidate = () => {
			if (contextRef.current !== context) return;
			contextRef.current = undefined;
			setContext(undefined);
			setContextChanged(true);
		};
		if (
			contextOwner.current.client !== client ||
			contextOwner.current.local !== local ||
			contextOwner.current.fileAuthority !== fileAuthority ||
			context.workspaceId !== workspaceId ||
			project.isError ||
			!preparedContextCurrent(context, project.data, selected, Date.now())
		) {
			invalidate();
			return;
		}
		const timeout = setTimeout(invalidate, Math.max(0, context.expiresAt - Date.now()));
		return () => clearTimeout(timeout);
	}, [context, workspaceId, project.data, project.isError, selected, client, local, fileAuthority]);
	useLayoutEffect(() => {
		if (focusRevision > 0) input.current?.focus();
	}, [focusRevision]);
	const send = () => {
		if (!draft.trim() || !ready || !selected || disabled || busy || sending.current) return;
		const consent = contextRef.current;
		if (
			consent &&
			(contextOwner.current.client !== client ||
				contextOwner.current.local !== local ||
				contextOwner.current.fileAuthority !== fileAuthority ||
				project.isFetching ||
				project.isError ||
				consent.workspaceId !== workspaceId ||
				!preparedContextCurrent(consent, project.data, selected, Date.now()))
		) {
			changeContext(undefined);
			setContextChanged(true);
			return;
		}
		sending.current = true;
		setFailed(false);
		changeContext(undefined);
		const model = { provider: selected.provider, modelId: selected.modelId };
		void (consent ? onSend(draft, model, consent) : onSend(draft, model))
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
						{workspaceId && (
							<Button
								ref={consentTrigger}
								type="button"
								variant="ghost"
								size="sm"
								className="prepared-project-permissions"
								data-staged={!!context}
								aria-haspopup="dialog"
								aria-expanded={consentOpen}
								disabled={disabled || busy}
								onClick={() => setConsentOpen(true)}
							>
								<ShieldCheck size={15} aria-hidden="true" />
								{context ? consentLabels.staged : consentLabels.control}
							</Button>
						)}
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
										if (key !== modelKey && contextRef.current) {
											changeContext(undefined);
											setContextChanged(true);
										}
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
			{context && <p className="prepared-context-note">{consentLabels.onSend}</p>}
			{contextChanged && <output className="prepared-context-note">{consentLabels.changed}</output>}
			{consentOpen && (
				<PreparedProjectConsent
					folder={project.data}
					model={selected}
					value={context}
					disabled={disabled || busy || project.isFetching || project.isError || !ready}
					onChange={changeContext}
					onClose={() => setConsentOpen(false)}
					onRestoreFocus={() => {
						if (consentTrigger.current?.isConnected) consentTrigger.current.focus({ preventScroll: true });
						else input.current?.focus({ preventScroll: true });
					}}
				/>
			)}
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
