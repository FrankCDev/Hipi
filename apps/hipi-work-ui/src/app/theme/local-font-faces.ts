import type { InstalledFontFace } from "@hipi/work-runtime/appearance";

export function localFaceFamily(face: InstalledFontFace) {
	return `"Hipi local ${face.postscriptName}"`;
}
/** Each owner registers at most three locally installed faces and removes them on config change/unmount. */
export function applyLocalFontFaces(faces: Partial<Record<"ui" | "content" | "code", InstalledFontFace>>) {
	if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return () => {};
	let disposed = false;
	const registered: FontFace[] = [];
	for (const face of Object.values(faces)) {
		const font = new FontFace(
			`Hipi local ${face.postscriptName}`,
			`local("${face.postscriptName}"), local("${face.fullName}")`,
		);
		void font.load().then(
			(loaded) => {
				if (disposed) return;
				document.fonts.add(loaded);
				registered.push(loaded);
			},
			() => {
				// Missing local faces keep the user's configured family and system fallback.
			},
		);
	}
	return () => {
		disposed = true;
		for (const font of registered) document.fonts.delete(font);
	};
}
