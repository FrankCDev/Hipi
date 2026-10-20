// Source-only diagnostic encoder for this harness's 1600x1000x24 private Xvfb.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

export const maxPickerImageBytes = 1600 * 1000 * 4 + 4096 + 256 * 12;

/** Accept only bounded XWD v7 TrueColor ZPixmap data, never arbitrary image formats. */
function pickerPixels(bytes) {
	assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 100 && bytes.length <= maxPickerImageBytes);
	// XWDFile.h specifies 25 big-endian CARD32 fields, followed by name, colors, then pixels.
	const field = (index) => bytes.readUInt32BE(index * 4);
	const header = field(0);
	const width = field(4);
	const height = field(5);
	const order = field(7);
	const stride = field(12);
	const colors = field(19);
	assert.ok(header >= 101 && header <= 4096 && header <= bytes.length, "Unsupported XWD header length");
	assert.equal(bytes[header - 1], 0, "Unterminated XWD window name");
	assert.equal(field(1), 7, "Unsupported XWD version");
	assert.equal(field(2), 2, "Only XWD ZPixmap is supported");
	assert.equal(field(3), 24, "Only private Xvfb depth 24 is supported");
	assert.ok(width > 0 && width <= 1600 && height > 0 && height <= 1000, "XWD dimensions exceed private display");
	assert.equal(field(6), 0, "Unsupported XWD pixel offset");
	assert.ok(order === 0 || order === 1, "Unsupported XWD byte order");
	assert.equal(field(8), 32, "Unsupported XWD bitmap unit");
	assert.ok(field(9) === 0 || field(9) === 1, "Unsupported XWD bitmap order");
	assert.equal(field(10), 32, "Unsupported XWD bitmap padding");
	assert.equal(field(11), 32, "Unsupported XWD pixel size");
	assert.equal(stride, width * 4, "Unsupported XWD row layout");
	assert.equal(field(13), 4, "Only XWD TrueColor is supported");
	assert.deepEqual([field(14), field(15), field(16)], [0xff0000, 0xff00, 0xff], "Unsupported XWD RGB masks");
	assert.equal(field(17), 8, "Unsupported XWD channel depth");
	assert.ok(field(18) <= 256 && colors <= 256, "XWD color table exceeds bound");
	assert.equal(field(20), width, "XWD window/image width mismatch");
	assert.equal(field(21), height, "XWD window/image height mismatch");
	const offset = header + colors * 12;
	assert.equal(bytes.length, offset + stride * height, "Truncated or trailing XWD pixel data");
	const rows = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const source = offset + y * stride + x * 4;
			const pixel = order === 0 ? bytes.readUInt32LE(source) : bytes.readUInt32BE(source);
			const destination = y * (1 + width * 3) + 1 + x * 3;
			rows[destination] = (pixel >>> 16) & 0xff;
			rows[destination + 1] = (pixel >>> 8) & 0xff;
			rows[destination + 2] = pixel & 0xff;
		}
	}
	return { width, height, rows };
}

/** Fixed harness-only Open target, observed in owned CI run 39366653690, artifact 12240260777.
 * Fingerprint only four one-pixel button-border strips, not text, entry/caret or selection.
 * Different GTK theme/layout fails closed; there is deliberately no coordinate fallback.
 */
export function pickerOpenTarget(bytes) {
	const { width, height, rows } = pickerPixels(bytes);
	assert.equal(width, 1124, "Unreviewed native chooser width");
	assert.equal(height, 822, "Unreviewed native chooser height");
	assert.equal(bytes.readUInt32BE(24 * 4), 0, "Native chooser border would change coordinate translation");
	const border = [];
	for (const [left, top, right, bottom] of [
		[1040, 782, 1110, 783],
		[1040, 815, 1110, 816],
		[1032, 790, 1033, 808],
		[1117, 790, 1118, 808],
	]) {
		for (let y = top; y < bottom; y++)
			border.push(rows.subarray(y * (1 + width * 3) + 1 + left * 3, y * (1 + width * 3) + 1 + right * 3));
	}
	assert.equal(
		createHash("sha256").update(Buffer.concat(border)).digest("hex"),
		"7382b5ada3604ab5cffd2eb496673f9e99095fecd8cf81b51fcef931fc73ce6e",
		"Unreviewed native Open-button presentation",
	);
	return { x: 1075, y: 799, width, height };
}

export function pickerXwdToPng(bytes) {
	const { width, height, rows } = pickerPixels(bytes);
	const chunk = (type, data) => {
		const result = Buffer.alloc(data.length + 12);
		result.writeUInt32BE(data.length);
		result.write(type, 4, 4, "ascii");
		data.copy(result, 8);
		result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
		return result;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2; // RGB, with no metadata or copied XWD window name.
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
