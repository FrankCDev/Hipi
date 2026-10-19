import {
	AnnotationMode,
	getDocument,
	type PDFDocumentProxy,
	type PDFPageProxy,
	PDFWorker,
	type RenderTask,
} from "pdfjs-dist";
import LocalPdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { LocalPdfData } from "./pdf-local-data.ts";
import { previewLabels } from "./preview-labels.ts";

export const PDF_PIXEL_LIMIT = 16_000_000;
export function boundedPdfSize(width: number, height: number) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
		throw new Error("Invalid page size");
	const w = Math.ceil(width),
		h = Math.ceil(height);
	if (w * h > PDF_PIXEL_LIMIT || w > 16384 || h > 16384) throw new Error("Page size limit");
	return { width: w, height: h };
}
type CanvasEntry = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
/** Bound PDF.js auxiliary surfaces as well as the visible page canvas. */
class BoundedCanvasFactory {
	private surfaces = new Map<HTMLCanvasElement, number>();
	create(width: number, height: number): CanvasEntry {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		const entry = { canvas, context };
		this.reset(entry, width, height);
		return entry;
	}
	reset({ canvas }: CanvasEntry, width: number, height: number) {
		const size = boundedPdfSize(width, height);
		const total =
			[...this.surfaces.values()].reduce((sum, value) => sum + value, 0) -
			(this.surfaces.get(canvas) ?? 0) +
			size.width * size.height;
		if (total > PDF_PIXEL_LIMIT || (!this.surfaces.has(canvas) && this.surfaces.size >= 8))
			throw new Error("Canvas resource limit");
		this.surfaces.set(canvas, size.width * size.height);
		canvas.width = size.width;
		canvas.height = size.height;
	}
	destroy({ canvas }: CanvasEntry) {
		this.surfaces.delete(canvas);
		canvas.width = canvas.height = 0;
	}
}

export function PdfPreview({
	bytes,
	locale,
	fail,
}: {
	bytes: Uint8Array<ArrayBuffer>;
	locale: string;
	fail: () => void;
}) {
	const l = previewLabels(locale);
	const [pdf, setPdf] = useState<PDFDocumentProxy>();
	const [page, setPage] = useState(1);
	const [zoom, setZoom] = useState(1);
	const [rendering, setRendering] = useState(true);
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		let active = true;
		let worker: Worker | undefined;
		let wrapper: PDFWorker | undefined;
		let loading: ReturnType<typeof getDocument> | undefined;
		const timer = setTimeout(() => {
			if (active) fail();
		}, 30000);
		try {
			worker = new LocalPdfWorker();
			worker.onerror = () => {
				if (active) fail();
			};
			// An explicit real port bypasses PDF.js's automatic fake-worker fallback.
			wrapper = PDFWorker.create({ port: worker, verbosity: 0 });
			loading = getDocument({
				data: bytes.slice(),
				worker: wrapper,
				verbosity: 0,
				useWorkerFetch: false,
				BinaryDataFactory: LocalPdfData,
				CanvasFactory: BoundedCanvasFactory,
				useWasm: false,
				useSystemFonts: false,
				disableFontFace: true,
				enableXfa: false,
				enableHWA: false,
				isImageDecoderSupported: false,
				isOffscreenCanvasSupported: false,
				maxImageSize: PDF_PIXEL_LIMIT,
				canvasMaxAreaInBytes: PDF_PIXEL_LIMIT * 4,
				disableAutoFetch: true,
				disableRange: true,
				disableStream: true,
				stopAtErrors: true,
			});
			loading.onPassword = () => {
				if (active) fail();
			};
			void loading.promise.then(
				(document) => {
					clearTimeout(timer);
					if (!active) return;
					if (document.numPages < 1 || document.numPages > 200) {
						fail();
						return;
					}
					setPdf(document);
				},
				() => {
					if (active) fail();
				},
			);
		} catch {
			fail();
		}
		return () => {
			active = false;
			clearTimeout(timer);
			void loading?.destroy().catch(() => {});
			wrapper?.destroy();
			worker?.terminate();
		};
	}, [bytes, fail]);
	useEffect(() => {
		const surface = canvas.current;
		if (!pdf || !surface) return;
		let active = true;
		let task: RenderTask | undefined;
		let documentPage: PDFPageProxy | undefined;
		setRendering(true);
		const timer = setTimeout(() => {
			if (active) fail();
		}, 30000);
		void (async () => {
			try {
				const next = await pdf.getPage(page);
				if (!active) {
					next.cleanup();
					return;
				}
				documentPage = next;
				const viewport = next.getViewport({ scale: zoom });
				const size = boundedPdfSize(viewport.width, viewport.height);
				surface.width = size.width;
				surface.height = size.height;
				task = next.render({ canvas: surface, viewport, annotationMode: AnnotationMode.DISABLE });
				await task.promise;
				if (active) setRendering(false);
			} catch {
				if (active) fail();
			} finally {
				clearTimeout(timer);
				documentPage?.cleanup();
			}
		})();
		return () => {
			active = false;
			clearTimeout(timer);
			task?.cancel();
			documentPage?.cleanup();
			surface.width = surface.height = 0;
		};
	}, [pdf, page, zoom, fail]);
	return (
		<>
			<p className="small-copy">{l["preview.pdfNote"]}</p>
			<div className="file-actions">
				<Button size="sm" variant="outline" disabled={!pdf || page <= 1 || rendering} onClick={() => setPage(page - 1)}>
					{l["preview.previous"]}
				</Button>
				<output>
					{l["preview.page"]} {page} / {pdf?.numPages ?? "…"}
				</output>
				<Button
					size="sm"
					variant="outline"
					disabled={!pdf || page >= pdf.numPages || rendering}
					onClick={() => setPage(page + 1)}
				>
					{l["preview.next"]}
				</Button>
				<label>
					{l["preview.zoom"]}{" "}
					<select value={zoom} disabled={rendering} onChange={(event) => setZoom(Number(event.target.value))}>
						{[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
							<option value={value} key={value}>
								{new Intl.NumberFormat(locale, { style: "percent" }).format(value)}
							</option>
						))}
					</select>
				</label>
			</div>
			{rendering && <output>{l["preview.loading"]}</output>}
			<div className="file-preview-surface" aria-busy={rendering}>
				<canvas key={`${page}:${zoom}`} ref={canvas} role="img" aria-label={`${l["preview.pdf"]} ${page}`} />
			</div>
		</>
	);
}
