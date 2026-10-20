import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Folder, FolderOpen, FolderPlus, PanelRight, RefreshCw, Shield, ShieldX } from "lucide-react";
import { type SyntheticEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { projectFolderLabels } from "../workbench/project-folder-labels.ts";
import { useProjectFolder } from "../workbench/use-project-folder.ts";
import { DocumentPreviewPane } from "./document-preview.tsx";
import { FileBuffer } from "./file-buffer.tsx";
import { fileLabels } from "./file-labels.ts";
import { FileSplitView } from "./file-split-view.tsx";
import { FileTabs } from "./file-tabs.tsx";
import { FileTree } from "./file-tree.tsx";
import type { FileTreeMemory } from "./file-tree-model.ts";
import type { FileWorkspaceSession, FileWorkspaceSnapshot } from "./file-workspace-session.ts";
import "./file-workspace.css";

export { fileTarget } from "./file-tree-model.ts";

const emptyWorkspace: FileWorkspaceSnapshot = { tabs: [], limitReached: false };
const noSubscription = () => () => {};
const noWorkspace = () => emptyWorkspace;
type Decision = { action: () => boolean; paths: string[] };
type RootLifetime = { active: boolean };

/** Presentation never creates editor owners. Hiding this surface releases preview resources only. */
export function FileWorkbench({
	workspaceId,
	session,
	visible = true,
}: {
	workspaceId: string;
	session?: FileWorkspaceSession;
	visible?: boolean;
	guard?: (action: () => void) => void;
}) {
	const { files, fileAuthority, previews } = useFiles();
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const pl = projectFolderLabels(locale);
	const cache = useQueryClient();
	const state = useSyncExternalStore(
		session?.subscribe ?? noSubscription,
		session?.snapshot ?? noWorkspace,
		session?.snapshot ?? noWorkspace,
	);
	const tabs = state.tabs.filter((tab) => tab.target.workspaceId === workspaceId);
	const active = tabs.find((tab) => tab.id === state.activeId) ?? tabs[0];
	const [treeOpen, setTreeOpen] = useState(session?.layout.treeOpen ?? true);
	const [treeWidth, setTreeWidth] = useState(session?.layout.treeWidth ?? 240);
	const treeToggle = useRef<HTMLButtonElement>(null);
	const [rootId, setRootId] = useState<string>();
	const [accessOpen, setAccessOpen] = useState(false);
	const [manage, setManage] = useState<"pending" | "failed" | null>(null);
	const [decision, setDecision] = useState<Decision>();
	const currentDecision = useRef<Decision | undefined>(undefined);
	const decide = (next?: Decision) => {
		currentDecision.current = next;
		setDecision(next);
	};
	const [closing, setClosing] = useState(false);
	const authorityLease = useMemo(
		() => ({
			active: true,
			pending: false,
			closing: false,
			files,
			fileAuthority,
			session,
			workspaceId,
			cache,
			roots: new Map<string, RootLifetime>(),
		}),
		[files, fileAuthority, session, workspaceId, cache],
	);
	const currentAuthorityLease = useRef(authorityLease);
	currentAuthorityLease.current = authorityLease;
	const fallbackTrees = useRef(new Map<string, FileTreeMemory>());
	const project = useProjectFolder(workspaceId);
	const roots = useQuery({
		queryKey: ["fileRoots", workspaceId],
		queryFn: async ({ signal }) => {
			if (!files) throw new Error("Unavailable");
			await fileAuthority?.getProject?.(workspaceId);
			signal.throwIfAborted();
			return files.listRoots(workspaceId, signal);
		},
		enabled: !!files && !!workspaceId,
	});
	const projectRoot = project.data?.root;
	const projectRootId = projectRoot?.rootId;
	const selectedRoot =
		roots.data?.find((root) => root.rootId === rootId) ??
		roots.data?.find((root) => root.rootId === projectRootId) ??
		roots.data?.[0];
	const currentRoots = useRef(roots.data);
	currentRoots.current = roots.data;
	if (roots.data) {
		const ids = new Set(roots.data.filter((root) => root.workspaceId === workspaceId).map((root) => root.rootId));
		for (const [id, lifetime] of authorityLease.roots) {
			if (!ids.has(id)) {
				lifetime.active = false;
				authorityLease.roots.delete(id);
			}
		}
		for (const id of ids) if (!authorityLease.roots.has(id)) authorityLease.roots.set(id, { active: true });
	}
	// Row callbacks retain the observed root lifetime, not a later replacement with the same ID.
	const renderedRootLifetimes = new Map(authorityLease.roots);
	const activeRootId = active?.target.rootId;
	useEffect(() => {
		if (activeRootId) setRootId(activeRootId);
	}, [activeRootId]);
	useEffect(() => {
		// Navigation chooses the current project's root, never the previous project's root selection.
		setRootId(projectRoot?.workspaceId === workspaceId ? projectRoot.rootId : undefined);
	}, [workspaceId, projectRoot]);
	useEffect(() => {
		if (!visible) session?.suspendPreviews();
		else if (session && active?.kind === "preview") session.resumePreview(active.id);
	}, [session, visible, active?.id, active?.kind]);
	useEffect(() => () => session?.suspendPreviews(), [session]);
	useEffect(() => {
		authorityLease.active = true;
		setManage(null);
		setClosing(false);
		currentDecision.current = undefined;
		setDecision(undefined);
		return () => {
			authorityLease.active = false;
		};
	}, [authorityLease]);
	const mutateAuthority = async (action: () => Promise<void>) => {
		if (authorityLease.pending || !authorityLease.active || currentAuthorityLease.current !== authorityLease) return;
		authorityLease.pending = true;
		setManage("pending");
		try {
			await action();
			if (!authorityLease.active || currentAuthorityLease.current !== authorityLease) return;
			await Promise.all([
				cache.invalidateQueries({ queryKey: ["fileRoots", workspaceId] }),
				cache.invalidateQueries({ queryKey: ["projectFolder", workspaceId] }),
				cache.invalidateQueries({ queryKey: ["agent-context-roots", workspaceId] }),
			]);
			if (!authorityLease.active || currentAuthorityLease.current !== authorityLease) return;
			setManage(null);
		} catch {
			if (authorityLease.active && currentAuthorityLease.current === authorityLease) setManage("failed");
		} finally {
			authorityLease.pending = false;
		}
	};
	const revoke = (id: string, rootLifetime: RootLifetime | undefined) => {
		const isCurrent = () =>
			authorityLease.active &&
			currentAuthorityLease.current === authorityLease &&
			rootLifetime?.active === true &&
			authorityLease.roots.get(id) === rootLifetime &&
			!!currentRoots.current?.some((root) => root.workspaceId === workspaceId && root.rootId === id);
		if (!fileAuthority || !isCurrent() || authorityLease.pending) return;
		const affectedTabs = () =>
			(session?.snapshot().tabs ?? []).filter(
				(tab) => tab.target.workspaceId === workspaceId && tab.target.rootId === id,
			);
		const prepare = (): Decision => {
			const affected = affectedTabs();
			const reviewed = new Map(
				affected.flatMap((tab) =>
					tab.kind === "editor" && tab.editor.protected ? [[tab.editor, tab.editor.snapshot()] as const] : [],
				),
			);
			let committed = false;
			return {
				paths: affected.map((tab) => tab.target.path),
				action: () => {
					if (committed) return true;
					if (!isCurrent()) return true;
					if (authorityLease.pending) return false;
					const current = affectedTabs();
					if (
						current.some(
							(tab) =>
								tab.kind === "editor" && tab.editor.protected && reviewed.get(tab.editor) !== tab.editor.snapshot(),
						)
					) {
						decide(prepare());
						return false;
					}
					committed = true;
					void mutateAuthority(() => {
						session?.discard(current.map((tab) => tab.id));
						return fileAuthority.revokeRoot(workspaceId, id);
					});
					return true;
				},
			};
		};
		const review = prepare();
		if (affectedTabs().some((tab) => tab.kind === "editor" && tab.editor.protected)) decide(review);
		else review.action();
	};
	const close = async (ids: string[]) => {
		const isCurrent = () => authorityLease.active && currentAuthorityLease.current === authorityLease;
		if (!session || authorityLease.closing || !isCurrent()) return;
		const requested = session
			.snapshot()
			.tabs.filter((tab) => tab.target.workspaceId === workspaceId && ids.includes(tab.id))
			.map((tab) => tab.id);
		if (!requested.length) return;
		authorityLease.closing = true;
		setClosing(true);
		const blocked = await session.close(requested);
		authorityLease.closing = false;
		if (!isCurrent()) return;
		setClosing(false);
		const affected = () => session.snapshot().tabs.filter((tab) => blocked.includes(tab.id));
		const prepare = (): Decision => {
			const tabs = affected();
			const reviewed = new Map(
				tabs.flatMap((tab) =>
					tab.kind === "editor" && tab.editor.protected ? [[tab.editor, tab.editor.snapshot()] as const] : [],
				),
			);
			let committed = false;
			return {
				action: () => {
					if (committed || !isCurrent()) return true;
					if (
						affected().some(
							(tab) =>
								tab.kind === "editor" && tab.editor.protected && reviewed.get(tab.editor) !== tab.editor.snapshot(),
						)
					) {
						decide(prepare());
						return false;
					}
					committed = true;
					session.discard(affected().map((tab) => tab.id));
					return true;
				},
				paths: tabs.map((tab) => tab.target.path),
			};
		};
		if (affected().length) decide(prepare());
	};
	const pinFromInteraction = (event: SyntheticEvent) => {
		if (
			!session ||
			!active ||
			active.pinned ||
			!authorityLease.active ||
			currentAuthorityLease.current !== authorityLease ||
			session.snapshot().activeId !== active.id ||
			event.nativeEvent
				.composedPath()
				.some((node) => node instanceof Element && node.hasAttribute("data-tab-preview-pin-exempt"))
		)
			return;
		session.pin(active.id);
	};
	const memory = () => {
		if (!selectedRoot) return { expanded: [""], cursors: {}, scrollTop: 0 };
		if (session) return session.treeMemory(selectedRoot);
		const key = JSON.stringify([selectedRoot.workspaceId, selectedRoot.rootId]);
		let value = fallbackTrees.current.get(key);
		if (!value) {
			value = { expanded: [""], cursors: {}, scrollTop: 0 };
			fallbackTrees.current.set(key, value);
		}
		return value;
	};
	const access = (
		<div className="file-access-body">
			{fileAuthority && (
				<Button
					variant="outline"
					size="sm"
					disabled={manage === "pending"}
					onClick={() => void mutateAuthority(() => fileAuthority.chooseRoot(workspaceId))}
				>
					<FolderPlus size={16} aria-hidden />
					{l.choose}
				</Button>
			)}
			<ul className="file-access-list">
				{roots.data?.map((root) => (
					<li className="file-access-row" key={root.rootId}>
						<div>
							<span className="file-access-name">{root.displayName ?? l.root}</span>
							<span className="file-access-kind">{root.writable ? l["access.readWrite"] : l.readonly}</span>
						</div>
						{fileAuthority && (
							<Button
								size="sm"
								variant="ghost"
								disabled={manage === "pending"}
								onClick={() => revoke(root.rootId, renderedRootLifetimes.get(root.rootId))}
							>
								{l.revoke}
							</Button>
						)}
					</li>
				))}
			</ul>
			{manage === "failed" && <p role="alert">{l.failed}</p>}
		</div>
	);
	return (
		<aside className="file-workbench" aria-label={l.title}>
			{!files ? (
				<div className="file-state file-state-empty">
					<ShieldX aria-hidden />
					<h3>{l["state.unavailable"]}</h3>
					<p>{l.unavailable}</p>
				</div>
			) : !workspaceId ? (
				<div className="file-state file-state-empty">
					<Folder aria-hidden />
					<h3>{l["state.noWorkspace"]}</h3>
					<p>{l.noWorkspace}</p>
				</div>
			) : (
				<>
					<header className="file-workspace-toolbar">
						<span className="file-workspace-path" title={active?.target.path}>
							{active?.target.path ?? l.title}
						</span>
						<div className="file-workspace-tools">
							<Button
								ref={treeToggle}
								size="icon-sm"
								variant="ghost"
								aria-label={l["tree.toggle"]}
								aria-pressed={treeOpen}
								title={l["tree.toggle"]}
								onClick={() => {
									const open = !treeOpen;
									setTreeOpen(open);
									if (session) session.layout.treeOpen = open;
								}}
							>
								<PanelRight size={16} aria-hidden />
							</Button>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={l["access.title"]}
								title={l["access.title"]}
								onClick={() => setAccessOpen(true)}
							>
								<Shield size={16} aria-hidden />
							</Button>
						</div>
					</header>
					{state.limitReached && <output className="file-workspace-notice">{l["tabs.limit"]}</output>}
					<FileSplitView
						treeOpen={treeOpen}
						width={treeWidth}
						onCollapse={() => {
							setTreeOpen(false);
							if (session) session.layout.treeOpen = false;
							treeToggle.current?.focus({ preventScroll: true });
						}}
						onResize={(width) => {
							setTreeWidth(width);
							if (session) session.layout.treeWidth = width;
						}}
						content={
							<>
								{session && tabs.length > 0 && (
									<FileTabs
										tabs={tabs}
										activeId={active?.id}
										session={session}
										close={(ids) => void close(ids)}
										closing={closing}
									/>
								)}
								{active ? (
									<section
										className="file-tab-panel"
										id={`file-tab-content-${active.id}`}
										role="tabpanel"
										aria-labelledby={`file-tab-${active.id}`}
										onPointerDownCapture={pinFromInteraction}
										onKeyDownCapture={pinFromInteraction}
									>
										{active.kind === "editor" ? (
											<FileBuffer
												key={active.id}
												tab={active}
												retry={() => void session?.retry(active.id)}
												guard={(action) => {
													const editor = active.editor;
													const isCurrent = () =>
														authorityLease.active &&
														currentAuthorityLease.current === authorityLease &&
														session
															?.snapshot()
															.tabs.some(
																(tab) =>
																	tab.id === active.id &&
																	tab.kind === "editor" &&
																	tab.editor === editor &&
																	tab.target.workspaceId === workspaceId,
															);
													if (!isCurrent() || editor.snapshot().operation) return;
													const prepare = (): Decision => {
														const reviewed = editor.snapshot();
														let committed = false;
														return {
															action: () => {
																if (committed || !isCurrent()) return true;
																if (editor.protected && editor.snapshot() !== reviewed) {
																	decide(prepare());
																	return false;
																}
																if (editor.snapshot().operation) return false;
																committed = true;
																action();
																return true;
															},
															paths: [active.target.path],
														};
													};
													const review = prepare();
													if (editor.protected) decide(review);
													else review.action();
												}}
											/>
										) : (
											<DocumentPreviewPane session={active.preview} onClose={() => void close([active.id])} />
										)}
									</section>
								) : roots.data?.length === 0 ? (
									<div className="file-state file-state-empty">
										<FolderOpen aria-hidden />
										<h3>{l["empty.title"]}</h3>
										<p>{l.noRoots}</p>
										{fileAuthority && access}
									</div>
								) : (
									<div className="file-state file-state-empty">
										<FileText aria-hidden />
										<h3>{l["empty.selection"]}</h3>
										<p>{l.open}</p>
									</div>
								)}
							</>
						}
						tree={
							<>
								<div className="file-browser-heading">
									{(roots.data?.length ?? 0) > 1 ? (
										<Select value={selectedRoot?.rootId} onValueChange={setRootId}>
											<SelectTrigger size="sm" aria-label={l["tree.root"]}>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{roots.data?.map((root) => (
													<SelectItem key={root.rootId} value={root.rootId}>
														{root.displayName ?? l.root}
														{" · "}
														{root.writable ? l["access.readWrite"] : l.readonly}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : (
										<h3 title={selectedRoot?.displayName}>{selectedRoot?.displayName ?? l["browse.title"]}</h3>
									)}
									<Button
										size="icon-xs"
										variant="ghost"
										aria-label={l.refresh}
										title={l.refresh}
										disabled={roots.isFetching}
										onClick={() => {
											void roots.refetch();
											void cache.invalidateQueries({ queryKey: ["files", workspaceId] });
										}}
									>
										<RefreshCw size={16} aria-hidden />
									</Button>
								</div>
								{roots.isPending && <output className="file-loading">{l.loading}</output>}
								{project.data && ["unavailable", "moved", "revoked"].includes(project.data.status) && (
									<p className="file-state" role="alert">
										{pl[project.data.status]} {pl.recoverFromMenu}
									</p>
								)}
								{roots.isError && (
									<p className="file-state" role="alert">
										{l.failed}
									</p>
								)}
								{selectedRoot && (
									<FileTree
										key={`${workspaceId}:${selectedRoot.rootId}`}
										root={selectedRoot}
										files={files}
										memory={memory()}
										selected={active?.target}
										open={(target, writable, pinned) => void session?.open(target, writable, { pinned })}
										preview={previews && session ? (target) => void session.openPreview(target) : undefined}
									/>
								)}
							</>
						}
					/>
				</>
			)}
			<Dialog open={accessOpen} onOpenChange={setAccessOpen}>
				<DialogContent closeLabel={l["dialog.close"]}>
					<DialogTitle>{l["access.title"]}</DialogTitle>
					<DialogDescription>{l["access.description"]}</DialogDescription>
					{access}
				</DialogContent>
			</Dialog>
			<Dialog
				open={!!decision}
				onOpenChange={(open) => {
					if (!open) decide();
				}}
			>
				<DialogContent closeLabel={l.stay}>
					<DialogTitle>{l.leave}</DialogTitle>
					<DialogDescription>{l.leaveNote}</DialogDescription>
					<ul className="file-discard-paths">
						{decision?.paths.map((path) => (
							<li key={path}>{path}</li>
						))}
					</ul>
					<div className="file-actions">
						<Button variant="outline" onClick={() => decide()}>
							{l.stay}
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (!decision || currentDecision.current !== decision) return;
								const committed = decision.action();
								if (committed !== false && currentDecision.current === decision) decide();
							}}
						>
							{l.discard}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</aside>
	);
}
