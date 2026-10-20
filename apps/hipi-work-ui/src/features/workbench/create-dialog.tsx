import { LIMITS, type ModelReference } from "@hipi/work-runtime/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { workbenchLabels } from "./workbench-labels.ts";

export function CreateDialog({
	kind,
	onCreate,
	compact = false,
	disabled = false,
	onOpenChange,
	workspaceId,
	draft,
	onDraftChange,
	triggerLabel,
}: {
	kind: "workspace" | "conversation";
	onCreate: (name: string, model?: ModelReference, initialDraft?: string) => Promise<void>;
	compact?: boolean;
	disabled?: boolean;
	onOpenChange?: (open: boolean) => void;
	workspaceId?: string;
	draft?: string;
	onDraftChange?: (value: string) => void;
	triggerLabel?: string;
}) {
	const { t, locale } = usePreferences();
	const l = workbenchLabels(locale);
	const local = useLocalState();
	const nameId = useId();
	const promptId = useId();
	const [open, setOpen] = useState(false);
	const [ownDraft, setOwnDraft] = useState(() => (workspaceId ? (local.read(`task-draft.${workspaceId}`) ?? "") : ""));
	const prompt = draft ?? ownDraft;
	const prepared = kind === "conversation" && !!workspaceId;
	const client = useAppClient();
	const [modelKey, setModelKey] = useState("");
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
		enabled: open && kind === "conversation",
	});
	const selectedModel = catalog.data?.models.find((m) => JSON.stringify([m.provider, m.modelId]) === modelKey);
	const modelReady = kind === "workspace" || (!!selectedModel && !catalog.isError);
	const [name, setName] = useState("");
	const creating = useRef(false);
	const preparedName = name.trim() || (prepared ? (prompt.trim().split("\n")[0]?.slice(0, 128) ?? "") : "");
	const mutation = useMutation({
		mutationFn: (input: { name: string; model?: ModelReference; draft?: string }) =>
			onCreate(input.name, input.model, input.draft),
		onSuccess: () => {
			setOpen(false);
			onOpenChange?.(false);
			setName("");
		},
		onSettled: () => {
			creating.current = false;
		},
	});
	const create = () => {
		if (disabled || !modelReady || !preparedName || mutation.isPending || mutation.isError || creating.current) return;
		creating.current = true;
		mutation.mutate({
			name: preparedName,
			model: selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : undefined,
			...(prepared && prompt.trim() ? { draft: prompt } : {}),
		});
	};
	const title = t(kind === "workspace" ? "nav.newWorkspace" : "nav.newConversation");
	const trigger = (
		<DialogTrigger asChild>
			<Button
				variant="ghost"
				size={compact ? "icon-sm" : "default"}
				disabled={disabled}
				aria-label={title}
				className={compact ? undefined : "w-full justify-start"}
			>
				<Icon name="plus" size={16} />
				{!compact && (triggerLabel ?? title)}
			</Button>
		</DialogTrigger>
	);
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!mutation.isPending) {
					if (value && workspaceId && draft === undefined) setOwnDraft(local.read(`task-draft.${workspaceId}`) ?? "");
					setOpen(value);
					onOpenChange?.(value);
					mutation.reset();
				}
			}}
		>
			{compact ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{trigger}</TooltipTrigger>
						<TooltipContent>{title}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				trigger
			)}
			<DialogContent
				className={prepared ? "task-setup-dialog" : undefined}
				scrollBody
				closeLabel={t("common.close")}
				closeDisabled={mutation.isPending}
			>
				<DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
				<DialogDescription className="text-sm text-muted-foreground">
					{prepared
						? l["workbench.prepareDescription"]
						: t(kind === "workspace" ? "nav.workspaceDescription" : "nav.conversationDescription")}
				</DialogDescription>
				<DialogBody>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							// Creation is an explicit button action. Enter in the goal stays a newline, including IME confirmation.
							if (kind === "workspace") create();
						}}
						className="grid gap-4"
					>
						{prepared && (
							<label className="field task-goal-field" htmlFor={promptId}>
								{l["workbench.taskGoal"]}
								<Textarea
									id={promptId}
									className="task-setup-input"
									rows={4}
									value={prompt}
									maxLength={LIMITS.text}
									disabled={mutation.isPending || disabled}
									placeholder={l["workbench.taskPlaceholder"]}
									onChange={(event) => {
										const value = event.target.value;
										if (onDraftChange) onDraftChange(value);
										else {
											setOwnDraft(value);
											local.write(`task-draft.${workspaceId}`, value);
										}
									}}
								/>
								<span>{l["workbench.taskNotSent"]}</span>
							</label>
						)}
						<label className="field" htmlFor={nameId}>
							{prepared && prompt.trim() ? l["workbench.taskTitleOptional"] : t("common.name")}
							<Input
								className="task-title-input"
								id={nameId}
								disabled={mutation.isPending}
								autoComplete="off"
								maxLength={128}
								value={name}
								placeholder={prepared && prompt.trim() ? preparedName : undefined}
								onChange={(event) => setName(event.target.value)}
								required={!prepared || !prompt.trim()}
							/>
						</label>
						{kind === "conversation" && (
							<div className="grid gap-2">
								<Select
									value={modelKey}
									onValueChange={setModelKey}
									disabled={catalog.isPending || catalog.isError || mutation.isPending}
								>
									<SelectTrigger aria-label={t("model.select")} className="w-full">
										<SelectValue placeholder={t("model.select")} />
									</SelectTrigger>
									<SelectContent>
										{catalog.data?.models.map((m) => (
											<SelectItem
												key={JSON.stringify([m.provider, m.modelId])}
												value={JSON.stringify([m.provider, m.modelId])}
											>
												{m.name} · {m.provider}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-sm text-muted-foreground">{t("model.fixed")}</p>
								{selectedModel && (
									<p className="text-sm">
										{t(
											`model.${catalog.data?.providers.find((p) => p.provider === selectedModel.provider)?.credentialState ?? "unavailable"}`,
										)}
									</p>
								)}
								{catalog.isPending && <output>{t("common.loading")}</output>}
								{(catalog.isError || catalog.data?.models.length === 0) && (
									<p role="alert">{t(catalog.isError ? "model.failed" : "model.empty")}</p>
								)}
								<Button type="button" variant="ghost" onClick={() => void catalog.refetch()}>
									{t("model.refresh")}
								</Button>
							</div>
						)}
						{mutation.isError && (
							<p role="alert" className="error-text">
								{t("nav.creationUnknown")}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<DialogClose asChild>
								<Button variant="ghost" disabled={mutation.isPending}>
									{t("common.cancel")}
								</Button>
							</DialogClose>
							<Button
								type={kind === "workspace" ? "submit" : "button"}
								className="task-create-confirm"
								disabled={disabled || !modelReady || !preparedName || mutation.isPending || mutation.isError}
								onClick={kind === "conversation" ? create : undefined}
							>
								{t(mutation.isPending ? "common.loading" : "common.create")}
							</Button>
						</div>
					</form>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
