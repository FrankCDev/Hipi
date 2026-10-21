export type MessageViewportAnchor = { key: string; pixel: number };

/** CSS coordinates share the existing disclosure owner's zoom adjustment. */
export function messageViewportPixel(viewport: HTMLElement, key: string): number | undefined {
	const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id][data-message-key]")).find(
		(item) => item.dataset.messageKey === key,
	);
	if (!node?.isConnected) return undefined;
	const scale = viewport.offsetHeight > 0 ? viewport.getBoundingClientRect().height / viewport.offsetHeight : 1;
	if (!Number.isFinite(scale) || scale <= 0) return undefined;
	return (node.getBoundingClientRect().top - viewport.getBoundingClientRect().top) / scale;
}

export function captureMessageViewport(viewport: HTMLElement): MessageViewportAnchor | undefined {
	const top = viewport.getBoundingClientRect().top;
	const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id][data-message-key]")).find(
		(item) => item.getBoundingClientRect().bottom > top,
	);
	const key = node?.dataset.messageKey;
	if (!key) return undefined;
	const pixel = messageViewportPixel(viewport, key);
	return pixel === undefined ? undefined : { key, pixel };
}
