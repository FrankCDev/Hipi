import type { ProjectFolder } from "@hipi/work-runtime/files";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, FolderOpen, Link2Off, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import type { FileWorkspaceSession } from "../files/file-workspace-session.ts";
import { prepareProjectFolderChange } from "./project-folder-change.ts";
import { projectFolderLabels } from "./project-folder-labels.ts";
import { useProjectFolder } from "./use-project-folder.ts";
import "./project-folder.css";

export function ProjectFolderSummary({
	workspaceId,
	onManage,
	failed = false,
}: {
	workspaceId: string;
	onManage: (trigger: HTMLButtonElement) => void;
	failed?: boolean;
}) {
	const { locale } = usePreferences();
	const { fileAuthority } = useFiles();
	const l = projectFolderLabels(locale);
	const project = useProjectFolder(workspaceId);
	const folder = project.data;
	return (
		<button type="button" className="project-folder-summary" onClick={(event) => onManage(event.currentTarget)}>
			<Folder size={18} aria-hidden="true" />
			<span className="project-folder-copy">
				<strong>{folder?.displayName ?? l.title}</strong>
				<span className="project-folder-secondary">
					{failed
						? l.createFolderFailed
						: !fileAuthority?.getProject
							? l.unsupported
							: project.isError
								? l.failed
								: folder
									? l[folder.status]
									: l.loading}
				</span>
			</span>
			<span className="project-folder-summary-action">{folder?.status === "available" ? l.change : l.choose}</span>
		</button>
	);
}

/** The native dialog is a separate, explicit local-access action from model context consent. */
export function ProjectFolderDialog({
	workspaceId,
	name,
	session,
	onClose,
	initialFailure = false,
	onConfirmed,
	onRestoreFocus,
}: {
	workspaceId: string;
	name: string;
	session?: FileWorkspaceSession;
	onClose: () => void;
	initialFailure?: boolean;
	onConfirmed?: () => void;
	onRestoreFocus?: () => void;
}) {
	const { fileAuthority } = useFiles();
	const { locale } = usePreferences();
	const l = projectFolderLabels(locale);
	const cache = useQueryClient();
	const project = useProjectFolder(workspaceId);
	const folder = project.data;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<"failed" | "changed" | "createFolderFailed" | null>(
		initialFailure ? "createFolderFailed" : null,
	);
	type Review = {
		folder: ProjectFolder;
		operation: "choose" | "unbind";
		change: ReturnType<typeof prepareProjectFolderChange>;
	};
	const [review, setReview] = useState<Review>();
	const busy = useRef(false);
	const chooseTrigger = useRef<HTMLButtonElement>(null);
	const lifetime = useRef(true);
	useEffect(() => {
		lifetime.current = true;
		return () => {
			lifetime.current = false;
		};
	}, []);
	const supported = !!fileAuthority?.chooseProject && !!fileAuthority?.unbindProject;
	const changed = async (result: ProjectFolder) => {
		cache.setQueryData(["projectFolder", workspaceId], result);
		if (lifetime.current) onConfirmed?.();
		await Promise.all([
			cache.invalidateQueries({ queryKey: ["fileRoots", workspaceId] }),
			cache.invalidateQueries({ queryKey: ["agent-context-roots", workspaceId] }),
		]);
	};
	const execute = async (decision: Review) => {
		if (!lifetime.current || busy.current || !fileAuthority || !decision.change.unchanged()) {
			if (lifetime.current && !busy.current) setError("changed");
			return;
		}
		const current = cache.getQueryData<ProjectFolder>(["projectFolder", workspaceId]);
		if (current?.bindingId !== decision.folder.bindingId || current.revision !== decision.folder.revision) {
			setReview(undefined);
			setError("changed");
			return;
		}
		busy.current = true;
		setPending(true);
		setError(null);
		setReview(undefined);
		try {
			const result =
				decision.operation === "choose"
					? await fileAuthority.chooseProject?.(
							workspaceId,
							decision.folder.bindingId,
							locale === "en" ? "en" : "zh-CN",
						)
					: decision.folder.bindingId
						? await fileAuthority.unbindProject?.(workspaceId, decision.folder.bindingId)
						: undefined;
			// Native cancellation is not a mutation, a discard, or a failed operation.
			if (!result) return;
			if (!decision.change.discardReviewed() && lifetime.current) setError("changed");
			await changed(result);
		} catch {
			// Do not retry a picker or unbind after a lost reply. The explicit read-only check remains available.
			if (lifetime.current) setError("failed");
		} finally {
			busy.current = false;
			if (lifetime.current) {
				setPending(false);
				// The disabled trigger is restored by the next commit before browser focus is returned.
				requestAnimationFrame(() => {
					if (lifetime.current) chooseTrigger.current?.focus({ preventScroll: true });
				});
			}
		}
	};
	const request = (operation: Review["operation"]) => {
		if (!folder || pending || error || project.isFetching || !supported) return;
		const decision: Review = {
			folder,
			operation,
			change: prepareProjectFolderChange(session, workspaceId, folder.root?.rootId),
		};
		if (decision.change.paths.length) setReview(decision);
		else void execute(decision);
	};
	const check = async () => {
		if (busy.current) return;
		setError(null);
		const result = await project.refetch();
		if (result.data) await changed(result.data);
		if (result.isError && lifetime.current) setError("failed");
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) onClose();
			}}
		>
			<DialogContent
				className="project-folder-dialog"
				closeLabel={l.close}
				closeDisabled={pending}
				onCloseAutoFocus={(event) => {
					if (!onRestoreFocus) return;
					event.preventDefault();
					onRestoreFocus();
				}}
			>
				<DialogTitle>{review ? l.dirtyTitle : l.title}</DialogTitle>
				<DialogDescription>{review ? l.dirtyDescription : l.description}</DialogDescription>
				{review ? (
					<>
						<ul className="project-folder-dirty-paths">
							{review.change.paths.map((path) => (
								<li key={path}>{path}</li>
							))}
						</ul>
						{error && <p role="alert">{l[error]}</p>}
						<div className="project-folder-actions">
							<Button
								variant="ghost"
								onClick={() => {
									setReview(undefined);
									setError(null);
								}}
							>
								{l.keep}
							</Button>
							<Button variant="destructive" onClick={() => void execute(review)}>
								{l.discard}
							</Button>
						</div>
					</>
				) : (
					<>
						<div className="project-folder-identity">
							<FolderOpen size={25} aria-hidden="true" />
							<div>
								<strong>{folder?.displayName ?? name}</strong>
								<span>{folder ? l[folder.status] : project.isError ? l.failed : l.loading}</span>
								{folder?.status === "available" && <span>{l.readonly}</span>}
							</div>
						</div>
						<p className="project-folder-disclosure">{l.disclosure}</p>
						<details className="project-folder-write-help">
							<summary>{l.readonly}</summary>
							<p className="project-folder-disclosure">{l.writeAccess}</p>
						</details>
						{folder && !["available", "unbound"].includes(folder.status) && (
							<p className="project-folder-recovery">{l.recovery}</p>
						)}
						{!supported && <p>{l.unsupported}</p>}
						{error && <p role="alert">{l[error]}</p>}
						<div className="project-folder-actions">
							{folder?.bindingId && folder.status !== "revoked" && (
								<Button
									variant="ghost"
									disabled={pending || !!error || project.isFetching}
									onClick={() => request("unbind")}
								>
									<Link2Off size={15} aria-hidden="true" />
									{l.unbind}
								</Button>
							)}
							{(error || project.isError) && (
								<Button variant="outline" disabled={pending || project.isFetching} onClick={() => void check()}>
									<RefreshCw size={15} aria-hidden="true" />
									{l.check}
								</Button>
							)}
							<Button
								ref={chooseTrigger}
								disabled={!supported || !folder || pending || !!error || project.isFetching}
								onClick={() => request("choose")}
							>
								<FolderOpen size={15} aria-hidden="true" />
								{pending ? l.loading : folder?.status === "available" ? l.change : l.choose}
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
