import type { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { type Entry, fromBuffer, type ZipFile } from "yauzl";
import { DOCUMENT_LIMITS, type DocumentFormat, DocumentPreviewError } from "./contracts.ts";

/**
 * Read each entry once, validate its actual content, and return a private STORE ZIP.
 * Consumers MUST parse the returned bytes, never the original archive: ZIP readers
 * disagree about which headers, sizes and entry counts to trust.
 *
 * Payload is capped at 32 MiB; UTF-8 names at 8 MiB (each appears twice).
 * The result is at most 32 MiB + 2 * 8 MiB + 76 * 2048 + 22 bytes.
 * Final concatenation retains at most two such archives plus one 8 MiB entry
 * copy. These are buffer accounting bounds, not a process RSS/third-party heap
 * guarantee: decoded strings, inflater state and parser objects are additional.
 */
export async function inspectOfficeZip(bytes: Buffer, format: Exclude<DocumentFormat, "csv">): Promise<Buffer> {
	if (bytes.length > DOCUMENT_LIMITS.inputBytes) throw new DocumentPreviewError("DOCUMENT_LIMIT");
	return new Promise<Buffer>((resolve, reject) => {
		let archive: ZipFile | undefined;
		let stream: Readable | undefined;
		let settled = false;
		let total = 0;
		let count = 0;
		let nameBytes = 0;
		let offset = 0;
		let directoryBytes = 0;
		const entries: Buffer[] = [];
		const directory: Buffer[] = [];
		const names = new Set<string>();
		const finish = (error?: DocumentPreviewError, result?: Buffer) => {
			if (settled) return;
			settled = true;
			stream?.destroy();
			archive?.close();
			entries.length = 0;
			directory.length = 0;
			if (error || !result) reject(error ?? new DocumentPreviewError("INVALID_DOCUMENT"));
			else resolve(result);
		};
		fromBuffer(
			bytes,
			{ lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
			(error, zip) => {
				if (error || !zip) return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
				archive = zip;
				zip.on("error", () => finish(new DocumentPreviewError("INVALID_DOCUMENT")));
				zip.on("end", () => {
					if (settled) return;
					const main = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
					if (!names.has(main) || !names.has("[content_types].xml"))
						return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
					const end = Buffer.alloc(22);
					end.writeUInt32LE(0x06054b50);
					end.writeUInt16LE(count, 8);
					end.writeUInt16LE(count, 10);
					end.writeUInt32LE(directoryBytes, 12);
					end.writeUInt32LE(offset, 16);
					finish(undefined, Buffer.concat([...entries, ...directory, end], offset + directoryBytes + end.length));
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
					const encodedName = Buffer.from(name, "utf8");
					nameBytes += encodedName.length;
					if (
						++count > DOCUMENT_LIMITS.zipEntries ||
						encodedName.length > 0xffff ||
						nameBytes > DOCUMENT_LIMITS.inputBytes ||
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
							if (settled) return;
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
							chunks.length = 0;
							const checksum = crc32(content);
							if (size !== entry.uncompressedSize || checksum !== entry.crc32)
								return finish(new DocumentPreviewError("INVALID_DOCUMENT"));
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
							// Only generated metadata reaches downstream readers. No extra fields,
							// descriptors, comments or original local headers are copied.
							const local = Buffer.alloc(30);
							local.writeUInt32LE(0x04034b50);
							local.writeUInt16LE(20, 4);
							local.writeUInt16LE(0x800, 6);
							local.writeUInt16LE(33, 12); // 1980-01-01, the first valid DOS date.
							local.writeUInt32LE(checksum, 14);
							local.writeUInt32LE(size, 18);
							local.writeUInt32LE(size, 22);
							local.writeUInt16LE(encodedName.length, 26);
							const central = Buffer.alloc(46);
							central.writeUInt32LE(0x02014b50);
							central.writeUInt16LE(20, 4);
							central.writeUInt16LE(20, 6);
							central.writeUInt16LE(0x800, 8);
							central.writeUInt16LE(33, 14);
							central.writeUInt32LE(checksum, 16);
							central.writeUInt32LE(size, 20);
							central.writeUInt32LE(size, 24);
							central.writeUInt16LE(encodedName.length, 28);
							central.writeUInt32LE(offset, 42);
							entries.push(local, encodedName, content);
							directory.push(central, encodedName);
							offset += local.length + encodedName.length + size;
							directoryBytes += central.length + encodedName.length;
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
