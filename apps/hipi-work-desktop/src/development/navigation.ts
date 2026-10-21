interface Navigation {
	url: string;
	isMainFrame: boolean;
	isSameDocument: boolean;
	frame: unknown;
	initiator?: unknown;
}

/** Exact-page self-navigation for Vite, not a general origin or reload-only permission. */
export function developmentSelfNavigation(
	event: Navigation,
	owner: { isDestroyed(): boolean; mainFrame: { url: string } },
	page: string | undefined,
	isPackaged: boolean,
): boolean {
	if (isPackaged || !page || owner.isDestroyed()) return false;
	try {
		const frame = owner.mainFrame;
		return (
			event.isMainFrame === true &&
			event.isSameDocument === false &&
			event.frame === frame &&
			event.initiator === frame &&
			frame.url === page &&
			event.url === page
		);
	} catch {
		// A detached frame must fail closed, including when an Electron getter throws.
		return false;
	}
}
