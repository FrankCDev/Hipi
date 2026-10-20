import type { DocumentPreview } from "@hipi/work-runtime/previews/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { PdfPreview } from "./pdf-preview.tsx";
import { previewLabels } from "./preview-labels.ts";
import { PREVIEW_HANDLERS } from "./preview-registry.ts";
import type { PreviewSession } from "./preview-session.ts";

export function DocumentPage({ content, locale }: { content: DocumentPreview; locale: string }) {
	const l = previewLabels(locale);
	return (
		<>
			<p className="small-copy">{l[content.kind === "document" ? "preview.document" : "preview.grid"]}</p>
			{content.truncated && <p className="notice">{l["preview.partial"]}</p>}
			{content.kind === "document" ? (
				<pre className="file-preview-text">{content.text || l["preview.empty"]}</pre>
			) : (
				content.sheets.map((sheet, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Immutable page coordinates; sheets never reorder within a page.
					<section key={index}>
						<h4>
							{l["preview.sheet"]}: {sheet.name}
						</h4>
						{sheet.rows.length === 0 ? (
							<p>{l["preview.empty"]}</p>
						) : (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus is required to scroll a wide read-only grid.
							<section className="file-preview-grid" tabIndex={0} aria-label={sheet.name}>
								<table>
									<caption className="sr-only">{sheet.name}</caption>
									<tbody>
										{sheet.rows.map((row, rowIndex) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: Row coordinates are stable within an immutable page.
											<tr key={rowIndex}>
												{row.map((cell, columnIndex) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: Cell coordinates are stable within an immutable page.
													<td key={columnIndex}>{cell.display}</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</section>
						)}
					</section>
				))
			)}
		</>
	);
}
function ImagePreview({
	bytes,
	kind,
	locale,
	fail,
}: {
	bytes: Uint8Array<ArrayBuffer>;
	kind: "png" | "jpeg";
	locale: string;
	fail: () => void;
}) {
	const [url, setUrl] = useState<string>();
	const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		let objectUrl: string | undefined;
		try {
			objectUrl = URL.createObjectURL(new Blob([bytes], { type: `image/${kind}` }));
			setUrl(objectUrl);
			timeout.current = setTimeout(fail, 15000);
		} catch {
			fail();
		}
		return () => {
			clearTimeout(timeout.current);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [bytes, kind, fail]);
	return url ? (
		<img
			className="file-preview-image"
			src={url}
			alt={previewLabels(locale)["preview.image"]}
			onLoad={() => clearTimeout(timeout.current)}
			onError={fail}
		/>
	) : null;
}

/** Dispatch only on the service's validated format, never on extension or an arbitrary URL. */
export function DocumentPreviewPane({
	session,
	onClose,
	onRetry,
}: {
	session: PreviewSession;
	onClose?: () => void;
	onRetry?: () => void;
}) {
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const { files } = useFiles();
	const roots = useQuery({
		queryKey: ["fileRoots", state.target?.workspaceId],
		queryFn: ({ signal }) => {
			if (!files || !state.target) throw new Error("Unavailable");
			return files.listRoots(state.target.workspaceId, signal);
		},
		enabled: !!files && !!state.target && !state.error,
		refetchInterval: state.target && !state.error ? 5000 : false,
		refetchIntervalInBackground: true,
	});
	useEffect(() => {
		if (
			state.target &&
			!state.error &&
			(roots.isError || (roots.data && !roots.data.some((root) => root.rootId === state.target?.rootId)))
		)
			session.fail("UNAUTHORIZED");
	}, [roots.data, roots.isError, state.target, state.error, session]);
	const { locale } = usePreferences();
	const l = previewLabels(locale);
	const fail = useCallback(() => session.fail(), [session]);
	if (!state.target) return null;
	const handle = state.handle;
	return (
		<section className="file-buffer file-preview-buffer" aria-label={l["preview.open"]}>
			<div className="file-heading">
				<h3 className="file-path">{state.target.path}</h3>
				<Button size="sm" variant="ghost" onClick={onClose ?? (() => session.clear())}>
					{l["preview.close"]}
				</Button>
			</div>
			{state.loading && <output>{l["preview.loading"]}</output>}
			{state.error && (
				<div role="alert">
					<p>{l[state.error === "LIMIT_EXCEEDED" ? "preview.limit" : "preview.failed"]}</p>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							if (onRetry) onRetry();
							else if (state.target) void session.open(state.target);
						}}
					>
						{l["preview.retry"]}
					</Button>
				</div>
			)}
			{handle?.summary.truncated && <p className="notice">{l["preview.partial"]}</p>}
			{state.page && handle && (
				<>
					<div className="file-actions">
						<Button
							size="sm"
							variant="outline"
							disabled={state.loading || state.page.page === 0}
							onClick={() => void session.readPage((state.page?.page ?? 0) - 1)}
						>
							{l["preview.previous"]}
						</Button>
						<output>
							{l["preview.page"]} {state.page.page + 1} / {handle.summary.pages}
						</output>
						<Button
							size="sm"
							variant="outline"
							disabled={state.loading || state.page.page + 1 >= handle.summary.pages}
							onClick={() => void session.readPage((state.page?.page ?? 0) + 1)}
						>
							{l["preview.next"]}
						</Button>
					</div>
					<DocumentPage key={`${state.page.id}:${state.page.page}`} content={state.page.content} locale={locale} />
				</>
			)}
			{state.bytes &&
				handle &&
				(PREVIEW_HANDLERS[handle.kind].view === "pdf" ? (
					<PdfPreview key={handle.id} bytes={state.bytes} locale={locale} fail={fail} />
				) : (
					(handle.kind === "png" || handle.kind === "jpeg") && (
						<ImagePreview key={handle.id} bytes={state.bytes} kind={handle.kind} locale={locale} fail={fail} />
					)
				))}
		</section>
	);
}
