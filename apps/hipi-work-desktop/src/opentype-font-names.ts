import { AppearanceError, type InstalledFontFace, parseInstalledFontFace } from "@hipi/work-runtime/appearance";

/**
 * Bounded OpenType 'name' metadata only, not a font renderer. Prefer English Windows Unicode records,
 * then platform Unicode. Never synthesize a missing family, style, full name, or PostScript name.
 * https://learn.microsoft.com/typography/opentype/spec/name
 */
export function openTypeFontNames(base64: unknown): InstalledFontFace {
	if (
		typeof base64 !== "string" ||
		base64.length > 87384 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
	)
		throw new AppearanceError("INVALID");
	const data = Buffer.from(base64, "base64");
	if (data.length < 6 || data.length > 65536) throw new AppearanceError("INVALID");
	const version = data.readUInt16BE(0);
	const count = data.readUInt16BE(2);
	const start = data.readUInt16BE(4);
	if (version > 1 || count > 1024 || 6 + count * 12 > data.length || start < 6 + count * 12 || start > data.length)
		throw new AppearanceError("INVALID");
	const values = new Map<number, { score: number; value: string }>();
	for (let i = 0; i < count; i++) {
		const offset = 6 + i * 12;
		const platform = data.readUInt16BE(offset);
		const encoding = data.readUInt16BE(offset + 2);
		const language = data.readUInt16BE(offset + 4);
		const id = data.readUInt16BE(offset + 6);
		const length = data.readUInt16BE(offset + 8);
		const location = start + data.readUInt16BE(offset + 10);
		if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
		if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
		if (length % 2 || length < 2 || length > 256 || location + length > data.length) continue;
		const score = platform === 3 && language === 0x409 ? 3 : platform === 0 ? 2 : 1;
		if ((values.get(id)?.score ?? 0) >= score) continue;
		const value = new TextDecoder("utf-16be", { fatal: true }).decode(data.subarray(location, location + length));
		values.set(id, { score, value });
	}
	return parseInstalledFontFace({
		family: (values.get(16) ?? values.get(1))?.value,
		style: (values.get(17) ?? values.get(2))?.value,
		fullName: values.get(4)?.value,
		postscriptName: values.get(6)?.value,
	});
}
