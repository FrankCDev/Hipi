let clipboardIntent = 0;

/** All UI copy buttons share intent ownership; submitted OS writes remain non-cancelable. */
export async function writeClipboard(text: string): Promise<void> {
	clipboardIntent++;
	if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("Clipboard unavailable");
	await navigator.clipboard.writeText(text);
}

export type ClipboardPayload = { plain: string; html?: string };

/** A rejected rich write may fall back, but never after its feedback owner expires. */
export async function writeClipboardPayload(payload: ClipboardPayload, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const intent = ++clipboardIntent;
	if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("Clipboard unavailable");
	if (payload.html && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
		const documentOwner = typeof document === "undefined" ? undefined : document;
		const supersede = () => {
			clipboardIntent++;
		};
		const cleanup = () => {
			documentOwner?.removeEventListener("copy", supersede, true);
			signal?.removeEventListener("abort", cleanup);
		};
		documentOwner?.addEventListener("copy", supersede, true);
		signal?.addEventListener("abort", cleanup, { once: true });
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/plain": new Blob([payload.plain], { type: "text/plain" }),
					"text/html": new Blob([payload.html], { type: "text/html" }),
				}),
			]);
			return;
		} catch {
			signal?.throwIfAborted();
		} finally {
			cleanup();
		}
	}
	signal?.throwIfAborted();
	if (intent !== clipboardIntent) throw new Error("Clipboard attempt superseded");
	await navigator.clipboard.writeText(payload.plain);
}
