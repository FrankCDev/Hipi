import type { ModelReference, Scope } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { fileLabels } from "../files/file-labels.ts";
import { contextPaths } from "./context-paths.ts";
import { permissionLabels } from "./labels.ts";
import type { PermissionSession } from "./permission-session.ts";

export function ContextDialog({
	scope,
	model,
	session,
	disabled,
	disabledReason,
	open,
	onOpenChange,
	onCloseAutoFocus,
	contentId,
	status,
}: {
	scope: Scope;
	model?: ModelReference;
	session: PermissionSession;
	disabled: boolean;
	disabledReason?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus: (event: Event) => void;
	contentId: string;
	status: ReactNode;
}) {
	const { files, fileAuthority } = useFiles();
	const { locale } = usePreferences();
	const l = permissionLabels(locale);
	const fl = fileLabels(locale);
	const [rootId, setRootId] = useState("");
	const [paths, setPaths] = useState("");
	const [range, setRange] = useState("paths");
	const [duration, setDuration] = useState("900000");
	const pathsId = useId();
	const roots = useQuery({
		queryKey: ["agent-context-roots", scope.workspaceId],
		queryFn: async ({ signal }) => {
			await fileAuthority?.getProject?.(scope.workspaceId);
			signal.throwIfAborted();
			return files ? files.listRoots(scope.workspaceId, signal) : [];
		},
		enabled: open,
		retry: false,
		staleTime: 0,
	});
	const selectedRoot = roots.data?.find((root) => root.rootId === rootId);
	const pathPrefixes = contextPaths(paths, range === "whole");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				id={contentId}
				closeLabel={l["permissions.action.close"]}
				className="context-consent-dialog max-h-[85vh] overflow-y-auto"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DialogTitle>{l["permissions.context.authorize"]}</DialogTitle>
				<DialogDescription>{l["permissions.context.disclosure"]}</DialogDescription>
				{status}
				{disabledReason && <output>{disabledReason}</output>}
				<p>{l["permissions.context.scopeNote"]}</p>
				<p className="break-all">
					{l["permissions.context.model"]}: {model?.provider} / {model?.modelId}
				</p>
				<Select
					value={selectedRoot?.rootId ?? ""}
					onValueChange={setRootId}
					disabled={roots.isFetching || roots.isError}
				>
					<SelectTrigger aria-label={l["permissions.context.root"]}>
						<SelectValue placeholder={l["permissions.context.root"]} />
					</SelectTrigger>
					<SelectContent>
						{roots.data?.map((root) => (
							<SelectItem key={root.rootId} value={root.rootId}>
								{root.displayName ?? l["permissions.context.root"]}
								{" · "}
								{root.writable ? fl["access.readWrite"] : fl.readonly}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{roots.isPending && <output>{l["permissions.action.loading"]}</output>}
				{roots.isError && <p role="alert">{l["permissions.action.failed"]}</p>}
				{roots.data?.length === 0 && <p>{l["permissions.context.noRoots"]}</p>}
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger aria-label={l["permissions.context.range"]}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="paths">{l["permissions.context.selectedPaths"]}</SelectItem>
						<SelectItem value="whole">{l["permissions.context.wholeRoot"]}</SelectItem>
					</SelectContent>
				</Select>
				{range === "paths" && <label htmlFor={pathsId}>{l["permissions.context.paths"]}</label>}
				{range === "paths" && (
					<Textarea
						aria-invalid={paths !== "" && !pathPrefixes}
						id={pathsId}
						value={paths}
						onChange={(event) => setPaths(event.target.value)}
						maxLength={8192}
						className="rounded-md border border-input p-2 bg-background text-foreground"
					/>
				)}
				{range === "paths" && paths !== "" && !pathPrefixes && (
					<p role="alert">{l["permissions.context.invalidPaths"]}</p>
				)}
				<Select value={duration} onValueChange={setDuration}>
					<SelectTrigger aria-label={l["permissions.context.expiry"]}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="900000">{l["permissions.context.short"]}</SelectItem>
						<SelectItem value="3600000">{l["permissions.context.long"]}</SelectItem>
					</SelectContent>
				</Select>
				<p className="text-muted-foreground">{l["permissions.context.revokeNote"]}</p>
				<Button
					disabled={disabled || !model || !pathPrefixes || roots.isError || roots.isFetching || !selectedRoot}
					onClick={() => {
						if (disabled || !model || !pathPrefixes || !selectedRoot) return;
						void session
							.authorize({
								...scope,
								requestId: crypto.randomUUID(),
								rootId: selectedRoot.rootId,
								pathPrefixes,
								model,
								expiresAt: Date.now() + Number(duration),
								disclosureVersion: 1,
							})
							.then(() => {
								if (!session.getSnapshot().failed && !session.getSnapshot().uncertain) onOpenChange(false);
							});
					}}
				>
					{l["permissions.context.authorize"]}
				</Button>
			</DialogContent>
		</Dialog>
	);
}
