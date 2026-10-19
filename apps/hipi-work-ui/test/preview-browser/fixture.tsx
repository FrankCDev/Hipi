import type { AppClient } from "@hipi/work-runtime/contracts";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { PreviewClient, PreviewKind } from "@hipi/work-runtime/previews/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppClientProvider } from "../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../src/app/preferences.tsx";
import { DocumentPreviewPane } from "../../src/features/files/document-preview.tsx";
import { LocalPdfData } from "../../src/features/files/pdf-local-data.ts";
import { PreviewSession } from "../../src/features/files/preview-session.ts";
import "../../src/theme.css";

// Synthetic content and ports only. Rendering uses the production PDF.js worker and components.
function makePdf() {
	const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R /OpenAction 11 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [12 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F2 7 0 R >> >> /Contents 10 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		stream("BT /F1 24 Tf 40 220 Td (Hipi PDF Preview) Tj ET 0 0 1 rg 40 100 100 50 re f"),
		"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [8 0 R] >>",
		"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 9 0 R /DW 1000 >>",
		"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /Ascent 880 /Descent -120 /CapHeight 880 /ItalicAngle 0 /StemV 80 >>",
		stream("BT /F2 32 Tf 40 180 Td <4E2D6587988489C8> Tj ET"),
		"<< /S /JavaScript /JS (globalThis.pdfInjected = true) >>",
		"<< /Type /Annot /Subtype /Link /Rect [40 100 140 150] /A << /S /URI /URI (https://blocked.invalid/) >> >>",
	];
	let source = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(source.length);
		source += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = source.length;
	source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	source += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(source);
}
const pdf = makePdf();
const png = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="),
	(character) => character.charCodeAt(0),
);
let authorized = true;
let nextId = 0;
const handles = new Map<string, { kind: PreviewKind; bytes: Uint8Array<ArrayBuffer> }>();
const closed: string[] = [];
const resources: string[] = [];
const readResource = LocalPdfData.prototype.fetch;
LocalPdfData.prototype.fetch = async function (input) {
	resources.push(String(input.filename));
	return readResource.call(this, input);
};
const previews: PreviewClient = {
	open: async (target) => {
		const kind: PreviewKind = target.path === "sample.pdf" ? "pdf" : "png";
		const bytes = target.path === "invalid.png" ? new Uint8Array([1, 2, 3]) : kind === "pdf" ? pdf : png;
		const id = `preview-${++nextId}`;
		handles.set(id, { kind, bytes });
		return { id, revision: "a".repeat(64), kind, summary: { bytes: bytes.length, pages: 0, truncated: false } };
	},
	readPage: async () => {
		throw new Error("Binary fixture");
	},
	readBytes: async (id, offset) => {
		const item = handles.get(id);
		if (!item) throw new Error("Closed");
		return {
			id,
			revision: "a".repeat(64),
			offset,
			total: item.bytes.length,
			base64: btoa(String.fromCharCode(...item.bytes)),
		};
	},
	close: async (id) => {
		closed.push(id);
		handles.delete(id);
	},
};
const client: AppClient = {
	call: async () => {
		throw new Error("No runtime in component fixture");
	},
	observe: async () => {
		throw new Error("No runtime in component fixture");
	},
};
const files: FileClient = {
	listRoots: async () =>
		authorized ? [{ workspaceId: "fixture", rootId: "root", writable: false, displayName: "Synthetic files" }] : [],
	list: async () => ({ entries: [], nextCursor: null }),
	readText: async () => {
		throw new Error("No editor in fixture");
	},
	saveText: async () => {
		throw new Error("No writes in fixture");
	},
	preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
};
const session = new PreviewSession(previews);
function open(path: string) {
	authorized = true;
	return session.open({ workspaceId: "fixture", rootId: "root", path });
}
declare global {
	interface Window {
		previewFixture: {
			open(path: string): Promise<void>;
			close(): void;
			revoke(): void;
			stats(): { handles: number; closed: number; resources: string[]; error?: string };
		};
	}
}
window.previewFixture = {
	open,
	close: () => session.clear(),
	revoke: () => {
		authorized = false;
	},
	stats: () => ({ handles: handles.size, closed: closed.length, resources, error: session.snapshot().error }),
};
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(
	<StrictMode>
		<PreferencesProvider>
			<AppClientProvider client={client} files={files} previews={previews}>
				<main className="file-workbench" style={{ width: "100%" }}>
					<DocumentPreviewPane session={session} />
				</main>
			</AppClientProvider>
		</PreferencesProvider>
	</StrictMode>,
);
