export async function boundedCatalogBytes(response, limit = 32 * 1024 * 1024) {
	if (!response.body) throw new Error("Catalog response body is missing");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				throw new Error("Catalog exceeds the maximum download size");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}
