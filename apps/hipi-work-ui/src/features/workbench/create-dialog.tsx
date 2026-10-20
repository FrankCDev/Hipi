import type { ModelReference } from "@hipi/work-runtime/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";

export function CreateDialog({
	kind,
	onCreate,
	compact = false,
	disabled = false,
}: {
	kind: "workspace" | "conversation";
	onCreate: (name: string, model?: ModelReference) => Promise<void>;
	compact?: boolean;
	disabled?: boolean;
}) {
	const { t } = usePreferences();
	const nameId = useId();
	const [open, setOpen] = useState(false);
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
	const mutation = useMutation({
		mutationFn: (name: string) =>
			onCreate(name, selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : undefined),
		onSuccess: () => {
			setOpen(false);
			setName("");
		},
	});
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
				{!compact && title}
			</Button>
		</DialogTrigger>
	);
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!mutation.isPending) {
					setOpen(value);
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
			<DialogContent closeLabel={t("common.close")} closeDisabled={mutation.isPending}>
				<DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
				<DialogDescription className="text-sm text-muted-foreground">
					{t(kind === "workspace" ? "nav.workspaceDescription" : "nav.conversationDescription")}
				</DialogDescription>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!disabled && modelReady && name.trim() && !mutation.isPending && !mutation.isError)
							mutation.mutate(name.trim());
					}}
					className="grid gap-4"
				>
					<label className="field" htmlFor={nameId}>
						{t("common.name")}
						<Input
							id={nameId}
							disabled={mutation.isPending}
							autoComplete="off"
							maxLength={128}
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
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
							type="submit"
							disabled={disabled || !modelReady || !name.trim() || mutation.isPending || mutation.isError}
						>
							{t(mutation.isPending ? "common.loading" : "common.create")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
