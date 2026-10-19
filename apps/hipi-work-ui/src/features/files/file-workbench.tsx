import type { FileRoot, FileTarget } from "@hipi/work-runtime/files";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
}: {
	root: FileRoot;
	path: string;
	open: (target: FileTarget, writable: boolean) => void;
	preview?: (target: FileTarget) => void;
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
			{query.isPending && <output>{l.loading}</output>}
			{query.isError && (
				<div role="alert">
					{l.failed}
					<Button variant="outline" size="sm" onClick={() => void query.refetch()}>
						{l.retry}
					</Button>
				</div>
			)}
			{query.data?.entries.length === 0 && <p>{l.empty}</p>}
			<ul>
				{query.data?.entries.map((entry) => (
					<li key={entry.path}>
						<Button
							variant="ghost"
							size="sm"
							className="file-entry"
							disabled={entry.kind === "blocked"}
							aria-expanded={entry.kind === "directory" ? expanded === entry.path : undefined}
							onClick={() => {
								if (entry.kind === "directory") setExpanded(expanded === entry.path ? null : entry.path);
								else open(fileTarget(root, entry.path), root.writable);
							}}
						>
							<span aria-hidden="true">{entry.kind === "directory" ? (expanded === entry.path ? "▾" : "▸") : "·"}</span>
							<span>{entry.name}</span>
						</Button>
						{entry.kind === "file" && preview && (
							<Button size="sm" variant="outline" onClick={() => preview(fileTarget(root, entry.path))}>
								{previewLabels(locale)["preview.open"]}
							</Button>
						)}
						{entry.kind === "directory" && expanded === entry.path && (
							<Directory root={root} path={entry.path} open={open} preview={preview} />
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
			<header className="file-heading">
				<h2>{l.title}</h2>
				<Button
					variant="ghost"
					size="sm"
					disabled={!files || !workspaceId || roots.isFetching}
					onClick={() => {
						void roots.refetch();
						void cache.invalidateQueries({ queryKey: ["files", workspaceId] });
					}}
				>
					{l.refresh}
				</Button>
			</header>
			{!files ? (
				<p>{l.unavailable}</p>
			) : !workspaceId ? (
				<p>{l.noWorkspace}</p>
			) : (
				<>
					{fileAuthority && (
						<Button
							variant="outline"
							disabled={manage === "pending"}
							onClick={() => void mutateAuthority(() => fileAuthority.chooseRoot(workspaceId))}
						>
							{l.choose}
						</Button>
					)}
					{manage === "failed" && <p role="alert">{l.failed}</p>}
					{roots.isPending && <output>{l.loading}</output>}
					{roots.isError && <p role="alert">{l.failed}</p>}
					{roots.data?.length === 0 && <p>{l.noRoots}</p>}
					<div className="file-tree">
						{roots.data?.map((root) => (
							<section key={root.rootId}>
								<div className="file-root">
									<Button
										variant="ghost"
										size="sm"
										aria-expanded={expandedRoot === root.rootId}
										onClick={() => setExpandedRoot(expandedRoot === root.rootId ? null : root.rootId)}
									>
										{root.displayName ?? l.root}
									</Button>
									{!root.writable && <span>{l.readonly}</span>}
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
								</div>
								{expandedRoot === root.rootId && (
									<Directory
										root={root}
										path=""
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
			{session && !previewState?.target && <FileBuffer session={session} guard={guard} />}
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
			{state.error && (
				<p role="alert" className="error-text">
					{error}
				</p>
			)}
			{state.operation && (
				<div className="file-actions">
					<output>{l.loading}</output>
					<Button variant="outline" size="sm" onClick={() => session.cancel()}>
						{l.cancel}
					</Button>
				</div>
			)}
			{!document ? (
				<p>{l.open}</p>
			) : (
				<>
					<h3 className="file-path">{document.target.path}</h3>
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
					<p className="small-copy">
						{document.text === document.baseline.text ? l.clean : l.dirty} · {l.memory}
					</p>
					<div className="file-actions">
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
							{l.save}
						</Button>
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
						<Button
							size="sm"
							variant="ghost"
							disabled={!!state.operation}
							onClick={() => guard(() => session.reload())}
						>
							{l.reload}
						</Button>
						<Button size="sm" variant="ghost" aria-pressed={diff} onClick={() => setDiff((v) => !v)}>
							{diff ? l.edit : l.diff}
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
					</div>
					{diff ? (
						<>
							<p className="small-copy">{state.disk ? l.disk : l.baseline}</p>
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
