import { LIMITS, type ModelReference } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ComposerKeyboard } from "./composer-keyboard.ts";
import { COMPOSER_ROWS, resizeComposerTextarea } from "./composer-textarea.ts";
import { workbenchLabels } from "./workbench-labels.ts";

/** Send alone starts work. Opening, editing and choosing a model never create a conversation. */
export function PreparedTaskEntry({
	disabled,
	busy,
	onSend,
	draft,
	onDraftChange,
	onManageModels,
	focusRevision = 0,
}: {
	disabled: boolean;
	busy: boolean;
	onSend: (text: string, model: ModelReference) => Promise<void>;
	draft: string;
	onDraftChange: (value: string) => void;
	onManageModels: (returnFocus: HTMLButtonElement | null) => void;
	focusRevision?: number;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const { t, locale } = usePreferences();
	const input = useRef<HTMLTextAreaElement>(null);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const keyboard = useRef(new ComposerKeyboard());
	const sending = useRef(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [modelKey, setModelKey] = useState(() => local.read("new-chat-model") ?? "");
	const [failed, setFailed] = useState(false);
	const inputId = useId();
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
	});
	const configured = (provider: string) =>
		catalog.data?.providers.some((item) => item.provider === provider && item.credentialState === "configured");
	const selected =
		catalog.data?.models.find((model) => JSON.stringify([model.provider, model.modelId]) === modelKey) ??
		catalog.data?.models.find((model) => configured(model.provider)) ??
		catalog.data?.models[0];
	const ready = selected && configured(selected.provider) && !catalog.isError;
	useLayoutEffect(() => {
		if (input.current?.value === draft) resizeComposerTextarea(input.current);
	}, [draft]);
	useLayoutEffect(() => {
		if (focusRevision > 0) input.current?.focus();
	}, [focusRevision]);
	const send = () => {
		if (!draft.trim() || !ready || !selected || disabled || busy || sending.current) return;
		sending.current = true;
		setFailed(false);
		void onSend(draft, { provider: selected.provider, modelId: selected.modelId })
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
					<label className="sr-only" htmlFor={inputId}>
						{t("work.draft")}
					</label>
					<Textarea
						id={inputId}
						ref={input}
						className="composer-input prepared-task-input border-0 bg-transparent shadow-none focus-visible:ring-0"
						rows={COMPOSER_ROWS.min}
						value={draft}
						maxLength={LIMITS.text}
						placeholder={t("work.placeholder")}
						onChange={(event) => onDraftChange(event.target.value)}
						onCompositionStart={() => keyboard.current.compositionStart()}
						onCompositionEnd={(event) => keyboard.current.compositionEnd(event.timeStamp)}
						onBlur={() => keyboard.current.reset()}
						onKeyUp={() => keyboard.current.keyUp()}
						onKeyDown={(event) => {
							const action = keyboard.current.keyDown(event.nativeEvent);
							if (action !== "native") event.preventDefault();
							if (action === "submit") send();
						}}
					/>
				</form>
				<div className="composer-actions">
					<div className="composer-controls new-chat-controls">
						<Popover open={modelOpen} onOpenChange={setModelOpen}>
							<PopoverTrigger asChild>
								<Button
									ref={modelTrigger}
									variant="ghost"
									size="sm"
									className="new-chat-model-trigger"
									aria-label={t("model.select")}
								>
									<span>{selected?.name ?? t(catalog.isPending ? "common.loading" : "model.select")}</span>
									<ChevronDown size={14} aria-hidden="true" />
								</Button>
							</PopoverTrigger>
							<PopoverContent className="new-chat-model-menu" align="start">
								{catalog.data?.models.map((model) => {
									const key = JSON.stringify([model.provider, model.modelId]);
									const active = selected?.provider === model.provider && selected.modelId === model.modelId;
									return (
										<Button
											key={key}
											variant="ghost"
											className="new-chat-model-choice"
											aria-pressed={active}
											onClick={() => {
												setModelKey(key);
												local.write("new-chat-model", key);
												setModelOpen(false);
											}}
										>
											<span>
												<strong>{model.name}</strong>
												<span>{model.provider}</span>
											</span>
											{active && <Check size={16} aria-hidden="true" />}
										</Button>
									);
								})}
								{(catalog.isError || catalog.data?.models.length === 0) && (
									<p role="alert">{t(catalog.isError ? "model.failed" : "model.empty")}</p>
								)}
								<Button variant="ghost" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>
									<Icon name="refresh" size={15} />
									{t("model.refresh")}
								</Button>
								<Button
									variant="ghost"
									className="new-chat-manage-models"
									onClick={() => {
										setModelOpen(false);
										onManageModels(modelTrigger.current);
									}}
								>
									<Settings2 size={15} aria-hidden="true" />
									{t("model.settings")}
								</Button>
							</PopoverContent>
						</Popover>
						{selected && !configured(selected.provider) && (
							<output className="new-chat-model-warning">
								{t(
									`model.${catalog.data?.providers.find((item) => item.provider === selected.provider)?.credentialState ?? "unavailable"}`,
								)}
							</output>
						)}
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
