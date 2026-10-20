import type { Workspace } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { Folder, MessageCircle, Pencil } from "lucide-react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { PopoverHeader, PopoverTitle } from "../../../components/ui/popover.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import { projectFolderLabels } from "../projects/folder-labels.ts";
import { useProjectFolder } from "../projects/use-folder.ts";
import { projectConversationCount } from "./preview-metadata.ts";

/** Mounted on demand by the preview, never reads execution or grants model access. */
export function ProjectPreviewCard({
	workspace,
	onManageFolder,
	mode = "card",
}: {
	workspace: Workspace;
	onManageFolder?: () => void;
	mode?: "card" | "menu";
}) {
	const client = useAppClient();
	const { locale, t } = usePreferences();
	const l = catalogLabels(locale);
	const folders = projectFolderLabels(locale);
	const folder = useProjectFolder(workspace.workspaceId);
	const count = useQuery({
		queryKey: ["conversations", workspace.workspaceId, "all", "preview"],
		queryFn: ({ signal }) =>
			client.call("listConversations", { workspaceId: workspace.workspaceId, filter: "all" }, signal),
		staleTime: 15_000,
		retry: false,
	});
	return (
		<div className="project-preview-content">
			<PopoverHeader>
				<PopoverTitle className="project-preview-title">
					<Folder size={16} aria-hidden="true" />
					{workspace.name}
				</PopoverTitle>
			</PopoverHeader>
			{count.data && !count.isError && (
				<p className="project-preview-meta">
					<MessageCircle size={16} aria-hidden="true" />
					<span>{projectConversationCount(count.data.items.length, count.data.nextCursor !== null, locale)}</span>
				</p>
			)}
			{count.isPending && <p className="project-preview-meta">{t("common.loading")}</p>}
			{count.isError && mode === "card" && (
				<Button variant="ghost" size="sm" disabled={count.isFetching} onClick={() => void count.refetch()}>
					{l.reloadPreview}
				</Button>
			)}
			{folder.data?.workspaceId === workspace.workspaceId && !folder.isError && (
				<p className="project-preview-meta project-preview-path">
					<Folder size={16} aria-hidden="true" />
					<span
						className="project-preview-path-label"
						title={
							folder.data.status === "available"
								? (folder.data.displayPath ?? folder.data.displayName ?? undefined)
								: undefined
						}
					>
						{folder.data.status === "available"
							? (folder.data.displayPath ?? folder.data.displayName ?? folders.available)
							: folders[folder.data.status]}
					</span>
				</p>
			)}
			{folder.isError && mode === "card" && (
				<Button variant="ghost" size="sm" disabled={folder.isFetching} onClick={() => void folder.refetch()}>
					{folders.check}
				</Button>
			)}
			{onManageFolder && (
				<Button className="project-preview-edit" variant="ghost" size="sm" onClick={onManageFolder}>
					<Pencil size={16} aria-hidden="true" />
					{folders.title}
				</Button>
			)}
		</div>
	);
}
