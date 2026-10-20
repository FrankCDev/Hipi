import type { ModelReference } from "@hipi/work-runtime/contracts";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import { useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { contextPaths } from "../agent-permissions/context-paths.ts";
import { permissionLabels } from "../agent-permissions/labels.ts";
import type { StagedProjectConsent } from "./initial-context.ts";
import { preparedProjectConsentLabels } from "./prepared-project-consent-labels.ts";
import { projectFolderLabels } from "./project-folder-labels.ts";
import "./prepared-project-consent.css";

/** Presentation validity only; CatalogSession rechecks the live host and runtime before any mutation. */
export function preparedContextCurrent(
	context: StagedProjectConsent,
	folder: ProjectFolder | undefined,
	model: ModelReference | undefined,
	now: number,
) {
	return (
		folder?.status === "available" &&
		folder.workspaceId === context.workspaceId &&
		folder.bindingId === context.bindingId &&
		folder.revision === context.bindingRevision &&
		folder.root?.rootId === context.rootId &&
		model?.provider === context.model.provider &&
		model.modelId === context.model.modelId &&
		context.expiresAt > now
	);
}

/** This form captures consent intent only. It has no runtime client or mutation capability. */
export function PreparedProjectConsent({
	folder,
	model,
	value,
	disabled,
	onChange,
	onClose,
	onRestoreFocus,
}: {
	folder: ProjectFolder | undefined;
	model: ModelReference | undefined;
	value?: StagedProjectConsent;
	disabled: boolean;
	onChange: (context: StagedProjectConsent | undefined) => void;
	onClose: () => void;
	onRestoreFocus: () => void;
}) {
	const { locale } = usePreferences();
	const l = preparedProjectConsentLabels(locale);
	const p = permissionLabels(locale);
	const f = projectFolderLabels(locale);
	const [range, setRange] = useState(value?.pathPrefixes.includes("") === false ? "paths" : "whole");
	const [paths, setPaths] = useState(value?.pathPrefixes.filter(Boolean).join("\n") ?? "");
	const [duration, setDuration] = useState("900000");
	const pathsId = useId();
	const latest = useRef({ folder, model, disabled });
	latest.current = { folder, model, disabled };
	const pathPrefixes = contextPaths(paths, range === "whole");
	const available = folder?.status === "available" && folder.root && model;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				className="prepared-project-consent"
				closeLabel={p["permissions.action.close"]}
				scrollBody
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					onRestoreFocus();
				}}
			>
				<DialogTitle>{l.title}</DialogTitle>
				<DialogBody>
					<DialogDescription>{l.description}</DialogDescription>
					<p>{p["permissions.context.disclosure"]}</p>
					<div className="context-project-folder">
						<span>{f.consentFolder}</span>
						<strong>{folder?.displayName ?? f.title}</strong>
						<span>{f.readonly}</span>
					</div>
					<p>{l.scope}</p>
					<p className="break-all">
						{p["permissions.context.model"]}: {model?.provider} / {model?.modelId}
					</p>
					{!available && <p role="alert">{l.unavailable}</p>}
					<Select value={range} onValueChange={setRange} disabled={!available || disabled}>
						<SelectTrigger aria-label={p["permissions.context.range"]}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="paths">{p["permissions.context.selectedPaths"]}</SelectItem>
							<SelectItem value="whole">{f.consentWhole}</SelectItem>
						</SelectContent>
					</Select>
					{range === "paths" && (
						<>
							<label htmlFor={pathsId}>{p["permissions.context.paths"]}</label>
							<Textarea
								id={pathsId}
								aria-invalid={paths !== "" && !pathPrefixes}
								value={paths}
								onChange={(event) => setPaths(event.target.value)}
								maxLength={8192}
								disabled={disabled}
							/>
							{paths !== "" && !pathPrefixes && <p role="alert">{p["permissions.context.invalidPaths"]}</p>}
						</>
					)}
					<Select value={duration} onValueChange={setDuration} disabled={!available || disabled}>
						<SelectTrigger aria-label={p["permissions.context.expiry"]}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="900000">{p["permissions.context.short"]}</SelectItem>
							<SelectItem value="3600000">{p["permissions.context.long"]}</SelectItem>
						</SelectContent>
					</Select>
					<p className="text-muted-foreground">{p["permissions.context.revokeNote"]}</p>
				</DialogBody>
				<div className="prepared-consent-actions">
					{value && (
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								onChange(undefined);
								onClose();
							}}
						>
							{l.off}
						</Button>
					)}
					<Button type="button" variant="ghost" onClick={onClose}>
						{l.cancel}
					</Button>
					<Button
						type="button"
						disabled={disabled || !available || !pathPrefixes}
						onClick={() => {
							if (!folder?.root || !folder.bindingId || !model || !pathPrefixes || disabled) return;
							const intent: StagedProjectConsent = {
								workspaceId: folder.workspaceId,
								bindingId: folder.bindingId,
								bindingRevision: folder.revision,
								rootId: folder.root.rootId,
								model: { provider: model.provider, modelId: model.modelId },
								pathPrefixes,
								expiresAt: Date.now() + Number(duration),
								disclosureVersion: 1,
							};
							if (
								latest.current.disabled ||
								!preparedContextCurrent(intent, latest.current.folder, latest.current.model, Date.now())
							)
								return;
							onChange(intent);
							onClose();
						}}
					>
						{l.confirm}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
