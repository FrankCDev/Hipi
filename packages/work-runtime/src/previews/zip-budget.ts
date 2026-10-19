import type { Readable } from "node:stream";
import { type Entry, fromBuffer, type ZipFile } from "yauzl";
import { DOCUMENT_LIMITS, type DocumentFormat, DocumentPreviewError } from "./contracts.ts";

/** Streaming preflight precedes library parsing of exactly the same private bytes. */
export async function inspectOfficeZip(bytes: Buffer, format: Exclude<DocumentFormat, "csv">): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let archive: ZipFile | undefined;
		let stream: Readable | undefined;
		let settled = false;
		let total = 0;
		let count = 0;
		const names = new Set<string>();
		const finish = (error?: DocumentPreviewError) => {
			if (settled) return;
			settled = true;
			stream?.destroy();
			archive?.close();
			if (error) reject(error);
			else resolve();
		};
		fromBuffer(
			bytes,
			{ lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
			(error, zip) => {
				if (error || !zip) return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
				archive = zip;
				zip.on("error", () => finish(new DocumentPreviewError("INVALID_DOCUMENT")));
				zip.on("end", () => {
					const main = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
					finish(
						names.has(main) && names.has("[content_types].xml")
							? undefined
							: new DocumentPreviewError("INVALID_DOCUMENT"),
					);
				});
				zip.on("entry", (entry: Entry) => {
					if (settled) return;
					const name = entry.fileName;
					const normalized = name.toLowerCase();
					const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
					if (
						names.has(normalized) ||
						/[\\\x00-\x1f:%]/.test(name) ||
						parts.some((part) => !part || part === "." || part === "..") ||
						(entry.generalPurposeBitFlag & 1) !== 0 ||
						((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
						/(?:vbaproject|macrosheets|dialogsheets|embeddings|activex|oleobject)/i.test(name) ||
						/\.(?:bin|vba)$/i.test(name)
					)
						return finish(new DocumentPreviewError("UNSAFE_DOCUMENT"));
					names.add(normalized);
					if (
						++count > DOCUMENT_LIMITS.zipEntries ||
						entry.uncompressedSize > DOCUMENT_LIMITS.zipEntryBytes ||
						entry.uncompressedSize > Math.max(1, entry.compressedSize) * DOCUMENT_LIMITS.compressionRatio
					)
						return finish(new DocumentPreviewError("DOCUMENT_LIMIT"));
					zip.openReadStream(entry, (readError, opened) => {
						if (settled) {
							opened?.destroy();
							return;
						}
						if (readError || !opened) return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
						stream = opened;
						let size = 0;
						const chunks: Buffer[] = [];
						const xml = /\.(?:xml|rels)$/i.test(name);
						opened.on("error", () => finish(new DocumentPreviewError("INVALID_DOCUMENT")));
						opened.on("data", (chunk: Buffer) => {
							size += chunk.length;
							total += chunk.length;
							if (
								size > DOCUMENT_LIMITS.zipEntryBytes ||
								total > DOCUMENT_LIMITS.zipBytes ||
								size > Math.max(1, entry.compressedSize) * DOCUMENT_LIMITS.compressionRatio
							)
								return finish(new DocumentPreviewError("DOCUMENT_LIMIT"));
							chunks.push(chunk);
						});
						opened.on("end", () => {
							if (settled) return;
							const content = Buffer.concat(chunks);
							if (content.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
								return finish(new DocumentPreviewError("UNSAFE_DOCUMENT"));
							// Relationships can name XML parts with arbitrary extensions. Scan every
							// entry, including UTF-16/32 ASCII declarations, before any library sees it.
							if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(content.toString("utf8").replaceAll("\0", "")))
								return finish(new DocumentPreviewError("UNSAFE_DOCUMENT"));
							if (xml) {
								try {
									// Restrict XML to UTF-8: NUL/unsupported encoding rejection prevents declaration-scan bypasses.
									const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
									if (
										text.includes("\0") ||
										/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) ||
										/<\?xml[^?]*encoding\s*=\s*["'](?!utf-8["']|utf8["'])/i.test(text) ||
										/<(?:[\w.-]+:)?(?:oleObject|activeX|control)\b/i.test(text) ||
										/<(?:[\w.-]+:)?(?:Override|Relationship)\b[^>]*(?:macroEnabled|vbaProject|oleObject|activeX)/i.test(
											text,
										)
									)
										return finish(new DocumentPreviewError("UNSAFE_DOCUMENT"));
								} catch {
									return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
								}
							}
							stream = undefined;
							zip.readEntry();
						});
					});
				});
				zip.readEntry();
			},
		);
	});
}
