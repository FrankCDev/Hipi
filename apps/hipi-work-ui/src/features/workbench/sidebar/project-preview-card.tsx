import type { Project, Workspace } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { Folder, MessageCircle, Pencil, Pin, PinOff } from "lucide-react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { PopoverHeader, PopoverTitle } from "../../../components/ui/popover.tsx";
import { catalogLabels } from "../catalog/labels.ts";
import type { ProjectActionOwner } from "../projects/action-owner.ts";
import { projectFolderLabels } from "../projects/folder-labels.ts";
import { projectLabels } from "../projects/labels.ts";
import { ProjectEditableTitle } from "../projects/rename.tsx";
import { useProjectFolder } from "../projects/use-folder.ts";
import { projectConversationCount } from "./preview-metadata.ts";

/** Mounted on demand by the preview, never reads execution or grants model access. */
export function ProjectPreviewCard({
	workspace,
	project,
	logicalReady = true,
	onManageFolder,
	mode = "card",
	owner,
}: {
	owner?: ProjectActionOwner;
	logicalReady?: boolean;
	onManageFolder?: () => void;
	mode?: "card" | "menu";
} & ({ workspace: Workspace; project?: never } | { project: Project; workspace?: never })) {
	const client = useAppClient();
	const { locale, t } = usePreferences();
	const l = catalogLabels(locale);
	const folders = projectFolderLabels(locale);
	const workspaceId = project ? project.homeWorkspaceId : workspace.workspaceId;
	const logical = project !== undefined;
	const actions =
		logical && logicalReady && mode === "card" && owner?.projectId === project.projectId ? owner : undefined;
	const folder = useProjectFolder(workspaceId);
	const count = useQuery<{ count: number; partial: boolean; state: "building" | "refreshing" | "ready" }>({
		queryKey: logical
			? ["sidebar-navigation", "project-summary", project.projectId, "all"]
			: ["conversations", workspaceId, "all", "preview"],
		queryFn: ({ signal }) =>
			logical
				? client
						.call("getProjectConversationSummary", { projectId: project.projectId, filter: "all" }, signal)
						.then((summary) => ({
							count: summary.matchedAtLeast,
							partial: !summary.complete || summary.coverage.state !== "ready",
							state: summary.coverage.state,
						}))
				: client
						.call("listConversations", { workspaceId, filter: "all" }, signal)
						.then((page) => ({ count: page.items.length, partial: page.nextCursor !== null, state: "ready" as const })),
		enabled: !logical || logicalReady,
		staleTime: 15_000,
		retry: false,
	});
	return (
		<div className="project-preview-content">
			<PopoverHeader>
				<PopoverTitle className="project-preview-title">
					<Folder size={16} aria-hidden="true" />
					{actions ? (
						<ProjectEditableTitle name={project?.name ?? ""} owner={actions} />
					) : project ? (
						project.name
					) : (
						workspace.name
					)}
					{actions?.projectPinEnabled && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="project-preview-pin"
							disabled={actions.pinDisabled}
							aria-label={actions.pinned ? projectLabels(locale).unpin : projectLabels(locale).pin}
							onClick={actions.togglePin}
						>
							{actions.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
						</Button>
					)}
				</PopoverTitle>
			</PopoverHeader>
			{actions?.inlineFailed && <p role="alert">{l.failed}</p>}
			{(!logical || logicalReady) &&
				count.data &&
				!count.isError &&
				count.data.state !== "building" &&
				(!count.data.partial || count.data.count > 0) && (
					<p className="project-preview-meta">
						<MessageCircle size={16} aria-hidden="true" />
						<span>{projectConversationCount(count.data.count, count.data.partial, locale)}</span>
					</p>
				)}
			{(count.isPending || (logical && !logicalReady) || (!count.isError && count.data?.state === "building")) && (
				<p className="project-preview-meta">{t("common.loading")}</p>
			)}
			{logicalReady && !count.isError && count.data?.state === "refreshing" && (
				<p className="project-preview-meta">{l.refreshing}</p>
			)}
			{(!logical || logicalReady) && count.isError && mode === "card" && (
				<Button variant="ghost" size="sm" disabled={count.isFetching} onClick={() => void count.refetch()}>
					{l.reloadPreview}
				</Button>
			)}
			{folder.data?.workspaceId === workspaceId && !folder.isError && (
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
			{onManageFolder && mode === "card" && (
				<Button className="project-preview-edit" variant="ghost" size="sm" onClick={onManageFolder}>
					<Pencil size={16} aria-hidden="true" />
					{folders.title}
				</Button>
			)}
		</div>
	);
}
