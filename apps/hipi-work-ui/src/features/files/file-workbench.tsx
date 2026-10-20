import type { FileRoot, FileTarget } from "@hipi/work-runtime/files";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronRight,
	Eye,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	RefreshCw,
	Save,
	Shield,
	ShieldX,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { CodeDiff, CodeEditor } from "./code-editor.tsx";
import { DocumentPreviewPane } from "./document-preview.tsx";
import type { EditorSession, EditorSnapshot } from "./editor-session.ts";
import { fileLabels } from "./file-labels.ts";
import { previewLabels } from "./preview-labels.ts";
import { PreviewSession } from "./preview-session.ts";

export function fileTarget(root: FileRoot, path: string): FileTarget {
	return { workspaceId: root.workspaceId, rootId: root.rootId, path };
}

type Guard = (action: () => void) => void;
const noSubscription = () => () => {};
const noPreview = () => undefined;
const noEditor = (): EditorSnapshot | undefined => undefined;
function Directory({
	root,
	path,
	open,
	preview,
	selected,
}: {
	root: FileRoot;
	path: string;
	open: (target: FileTarget, writable: boolean) => void;
	preview?: (target: FileTarget) => void;
	selected?: FileTarget;
}) {
	const { files } = useFiles();
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const [expanded, setExpanded] = useState<string | null>(null);
	const cursor = cursors.at(-1);
	const query = useQuery({
		queryKey: ["files", root.workspaceId, root.rootId, path, cursor],
		queryFn: ({ signal }) => {
			if (!files) throw new Error("Unavailable");
			return files.list(fileTarget(root, path), cursor, signal);
		},
		gcTime: 0,
	});
	return (
		<div className="file-directory">
			{query.isPending && <output className="file-loading">{l.loading}</output>}
			{query.isError && (
				<div role="alert" className="file-state" data-tone="error">
					{l.failed}
					<Button variant="outline" size="sm" onClick={() => void query.refetch()}>
						{l.retry}
					</Button>
				</div>
			)}
			{query.data?.entries.length === 0 && <p className="file-directory-empty">{l.empty}</p>}
			<ul>
				{query.data?.entries.map((entry) => (
					<li key={entry.path}>
						<div
							className="file-entry-row"
							data-selected={selected?.rootId === root.rootId && selected.path === entry.path ? "true" : undefined}
						>
							<Button
								variant="ghost"
								size="sm"
								className="file-entry"
								title={entry.name}
								disabled={entry.kind === "blocked"}
								aria-current={selected?.rootId === root.rootId && selected.path === entry.path ? "true" : undefined}
								aria-expanded={entry.kind === "directory" ? expanded === entry.path : undefined}
								onClick={() => {
									if (entry.kind === "directory") setExpanded(expanded === entry.path ? null : entry.path);
									else open(fileTarget(root, entry.path), root.writable);
								}}
							>
								{entry.kind === "directory" ? (
									<>
										<ChevronRight aria-hidden="true" className="file-chevron" />
										<Folder aria-hidden="true" />
									</>
								) : entry.kind === "blocked" ? (
									<ShieldX aria-hidden="true" />
								) : (
									<FileText aria-hidden="true" />
								)}
								<span>{entry.name}</span>
							</Button>
							{entry.kind === "blocked" && <span className="file-entry-status">{l["state.blocked"]}</span>}
							{entry.kind === "file" && preview && (
								<Button
									size="sm"
									variant="ghost"
									className="file-preview-action"
									title={entry.name}
									onClick={() => preview(fileTarget(root, entry.path))}
								>
									<Eye aria-hidden="true" />
									{previewLabels(locale)["preview.open"]}
								</Button>
							)}
						</div>
						{entry.kind === "directory" && expanded === entry.path && (
							<Directory root={root} path={entry.path} open={open} preview={preview} selected={selected} />
						)}
					</li>
				))}
			</ul>
			<div className="file-actions">
				{cursors.length > 1 && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setExpanded(null);
							setCursors((c) => c.slice(0, -1));
						}}
					>
						{l.previous}
					</Button>
				)}
				{query.data?.nextCursor && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							const next = query.data.nextCursor;
							if (next) {
								setExpanded(null);
								setCursors((c) => [...c, next]);
							}
						}}
					>
						{l.next}
					</Button>
				)}
			</div>
		</div>
	);
}
export function FileWorkbench({
	workspaceId,
	session,
	guard,
}: {
	workspaceId: string;
	session?: EditorSession;
	guard: Guard;
}) {
	const { files, fileAuthority, previews } = useFiles();
	const previewSession = useMemo(
		() => (previews && workspaceId ? new PreviewSession(previews) : undefined),
		[previews, workspaceId],
	);
	useEffect(() => () => previewSession?.dispose(), [previewSession]);
	const previewState = useSyncExternalStore(
		previewSession?.subscribe ?? noSubscription,
		previewSession?.snapshot ?? noPreview,
		previewSession?.snapshot ?? noPreview,
	);
	const editorState = useSyncExternalStore(
		session?.subscribe ?? noSubscription,
		session?.snapshot ?? noEditor,
		session?.snapshot ?? noEditor,
	);
	useEffect(() => {
		if (editorState?.artifactRequest) previewSession?.clear();
	}, [editorState?.artifactRequest, previewSession]);
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const cache = useQueryClient();
	const [expandedRoot, setExpandedRoot] = useState<string | null>(null);
	const [manage, setManage] = useState<"pending" | "failed" | null>(null);
	const roots = useQuery({
		queryKey: ["fileRoots", workspaceId],
		queryFn: ({ signal }) => {
			if (!files) throw new Error("Unavailable");
			return files.listRoots(workspaceId, signal);
		},
		enabled: !!files && !!workspaceId,
	});
	const mutateAuthority = async (action: () => Promise<void>) => {
		if (manage === "pending") return;
		setManage("pending");
		try {
			await action();
			await cache.invalidateQueries({ queryKey: ["fileRoots", workspaceId] });
			setManage(null);
		} catch {
			setManage("failed");
		}
	};
	return (
		<aside className="file-workbench" aria-label={l.title}>
			{!files ? (
				<div className="file-state file-state-empty">
					<ShieldX aria-hidden="true" />
					<h3>{l["state.unavailable"]}</h3>
					<p>{l.unavailable}</p>
				</div>
			) : !workspaceId ? (
				<div className="file-state file-state-empty">
					<Folder aria-hidden="true" />
					<h3>{l["state.noWorkspace"]}</h3>
					<p>{l.noWorkspace}</p>
				</div>
			) : (
				<>
					{(fileAuthority || !!roots.data?.length) && (
						<details className="file-access" open={roots.data?.length === 0}>
							<summary>
								<Shield aria-hidden="true" />
								<span>{l["access.title"]}</span>
								<ChevronRight aria-hidden="true" className="file-chevron" />
							</summary>
							<div className="file-access-body">
								{fileAuthority && (
									<Button
										variant="outline"
										size="sm"
										disabled={manage === "pending"}
										onClick={() => void mutateAuthority(() => fileAuthority.chooseRoot(workspaceId))}
									>
										<FolderPlus aria-hidden="true" />
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
													onClick={() =>
														guard(() => {
															session?.clear();
															previewSession?.clear();
															void mutateAuthority(() => fileAuthority.revokeRoot(workspaceId, root.rootId));
														})
													}
												>
													{l.revoke}
												</Button>
											)}
										</li>
									))}
								</ul>
							</div>
						</details>
					)}
					{manage === "failed" && (
						<p className="file-state" data-tone="error" role="alert">
							{l.failed}
						</p>
					)}
					<div className="file-browser-heading">
						<h3>{l["browse.title"]}</h3>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={l.refresh}
							title={l.refresh}
							disabled={roots.isFetching}
							onClick={() => {
								void roots.refetch();
								void cache.invalidateQueries({ queryKey: ["files", workspaceId] });
							}}
						>
							<RefreshCw aria-hidden="true" />
						</Button>
					</div>
					{roots.isPending && <output className="file-loading">{l.loading}</output>}
					{roots.isError && (
						<p className="file-state" data-tone="error" role="alert">
							{l.failed}
						</p>
					)}
					{roots.data?.length === 0 && (
						<div className="file-state file-state-empty">
							<FolderOpen aria-hidden="true" />
							<h3>{l["empty.title"]}</h3>
							<p>{l.noRoots}</p>
						</div>
					)}
					<div className="file-tree">
						{roots.data?.map((root) => (
							<section key={root.rootId}>
								<div className="file-root">
									<Button
										variant="ghost"
										size="sm"
										className="file-root-toggle"
										aria-expanded={expandedRoot === root.rootId}
										onClick={() => setExpandedRoot(expandedRoot === root.rootId ? null : root.rootId)}
									>
										<ChevronRight aria-hidden="true" className="file-chevron" />
										<Folder aria-hidden="true" />
										<span>{root.displayName ?? l.root}</span>
									</Button>
									{!root.writable && <span className="file-access-kind">{l.readonly}</span>}
								</div>
								{expandedRoot === root.rootId && (
									<Directory
										root={root}
										path=""
										selected={previewState?.target ?? editorState?.document?.target}
										preview={
											previewSession
												? (target) =>
														guard(() => {
															session?.clear();
															void previewSession.open(target);
														})
												: undefined
										}
										open={(target, writable) =>
											guard(() => {
												session?.clear();
												previewSession?.clear();
												void session?.open(target, writable);
											})
										}
									/>
								)}
							</section>
						))}
					</div>
				</>
			)}
			{session &&
				!previewState?.target &&
				(editorState?.document ||
					editorState?.operation ||
					editorState?.error ||
					editorState?.unknown !== undefined ||
					(files && workspaceId && !!roots.data?.length)) && <FileBuffer session={session} guard={guard} />}
			{previewSession && <DocumentPreviewPane session={previewSession} />}
		</aside>
	);
}
function FileBuffer({ session, guard }: { session: EditorSession; guard: Guard }) {
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const [diff, setDiff] = useState(false);
	const [adopt, setAdopt] = useState(false);
	const document = state.document;
	const error =
		state.unknown !== undefined
			? l.unknown
			: state.error === "VERSION_CONFLICT"
				? l.conflict
				: state.error === "LIMIT_EXCEEDED"
					? l.limit
					: ["UNSUPPORTED_ENCODING", "BLOCKED_RESOURCE"].includes(state.error ?? "")
						? l.blocked
						: state.error === "BUSY"
							? l.busy
							: l.failed;
	return (
		<section className="file-buffer">
			{(state.error || state.unknown !== undefined) && (
				<div
					role="alert"
					className="file-state file-state-alert"
					data-tone={state.unknown !== undefined || state.error === "VERSION_CONFLICT" ? "warning" : "error"}
				>
					<TriangleAlert aria-hidden="true" />
					<div>
						<strong>
							{state.unknown !== undefined
								? l["state.unknown"]
								: state.error === "VERSION_CONFLICT"
									? l["state.conflict"]
									: l["state.failed"]}
						</strong>
						<p>{error}</p>
					</div>
				</div>
			)}
			{state.operation && (
				<div className="file-actions file-operation">
					<output>{l[`operation.${state.operation}`]}</output>
					<Button variant="outline" size="sm" onClick={() => session.cancel()}>
						{l.cancel}
					</Button>
				</div>
			)}
			{!document ? (
				!state.operation &&
				!state.error &&
				state.unknown === undefined && (
					<div className="file-state file-state-empty">
						<FileText aria-hidden="true" />
						<h3>{l["empty.selection"]}</h3>
						<p>{l.open}</p>
					</div>
				)
			) : (
				<>
					<header className="file-document-header">
						<div className="file-document-title">
							<FileText aria-hidden="true" />
							<h3 className="file-path">{document.target.path}</h3>
						</div>
						<div className="file-document-status">
							<span data-dirty={document.text !== document.baseline.text ? "true" : undefined}>
								{document.text === document.baseline.text ? l.clean : l.dirty}
							</span>
							{!document.writable && <span className="file-access-kind">{l.readonly}</span>}
						</div>
					</header>
					{document.artifactReference && (
						<output className="small-copy block">
							{l["artifact.current"]}{" "}
							{document.artifactReference.expectedRevision
								? l[
										(state.disk?.revision ?? document.baseline.revision) === document.artifactReference.expectedRevision
											? "artifact.matches"
											: "artifact.changed"
									]
								: l["artifact.noRevision"]}
						</output>
					)}
					<p className="small-copy file-memory-note">{l.memory}</p>
					<div className="file-editor-toolbar">
						<fieldset className="file-action-group">
							<legend className="sr-only">{l["toolbar.edit"]}</legend>
							<Button
								size="sm"
								disabled={
									!document.writable ||
									!!state.operation ||
									state.unknown !== undefined ||
									state.error === "VERSION_CONFLICT" ||
									document.text === document.baseline.text
								}
								onClick={() => void session.save()}
							>
								<Save aria-hidden="true" />
								{l.save}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={!!state.operation}
								onClick={() => guard(() => session.reload())}
							>
								{l.reload}
							</Button>
						</fieldset>
						<fieldset className="file-action-group">
							<legend className="sr-only">{l["toolbar.compare"]}</legend>
							<Button
								size="sm"
								variant="outline"
								disabled={!!state.operation}
								onClick={() => {
									void session.compare();
									setDiff(true);
								}}
							>
								{l.compare}
							</Button>
							{state.disk && (state.error === "VERSION_CONFLICT" || state.unknown !== undefined) && (
								<Dialog open={adopt} onOpenChange={setAdopt}>
									<DialogTrigger asChild>
										<Button size="sm" variant="outline" disabled={!!state.operation}>
											{l.adopt}
										</Button>
									</DialogTrigger>
									<DialogContent closeLabel={l.cancel}>
										<DialogTitle>{l.adopt}</DialogTitle>
										<DialogDescription>{l.adoptNote}</DialogDescription>
										<Button
											disabled={!!state.operation}
											onClick={() => {
												session.adoptComparedRevision();
												setAdopt(false);
											}}
										>
											{l.adoptConfirm}
										</Button>
									</DialogContent>
								</Dialog>
							)}
						</fieldset>
					</div>
					<fieldset className="file-view-switch">
						<legend className="sr-only">{l["toolbar.view"]}</legend>
						<Button size="sm" variant="ghost" aria-pressed={!diff} onClick={() => setDiff(false)}>
							{l.edit}
						</Button>
						<Button size="sm" variant="ghost" aria-pressed={diff} onClick={() => setDiff(true)}>
							{l.diff}
						</Button>
					</fieldset>
					{diff ? (
						<>
							<p className="small-copy file-baseline-note">{state.disk ? l.disk : l.baseline}</p>
							<CodeDiff
								before={state.disk?.text ?? document.diffBaseline.text}
								after={document.text}
								left={l.left}
								right={l.right}
							/>
						</>
					) : (
						<CodeEditor
							key={`${document.target.workspaceId}/${document.target.rootId}/${document.target.path}`}
							text={document.text}
							onChange={(text) => session.edit(text)}
							readOnly={!document.writable || state.operation === "save"}
							label={l.editor}
						/>
					)}
				</>
			)}
		</section>
	);
}
