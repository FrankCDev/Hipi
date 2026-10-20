export type PreviewMode = "closed" | "hover" | "pinned";

type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };

/** The pointer may cross the gap diagonally without abandoning an interactive card. */
export function inPreviewCorridor(point: Point, origin: Point, target: Bounds) {
	if (point.x >= target.left && point.x <= target.right && point.y >= target.top && point.y <= target.bottom)
		return true;
	const edge = origin.x <= target.left ? target.left : target.right;
	if (edge === origin.x) return false;
	const progress = (point.x - origin.x) / (edge - origin.x);
	if (progress < 0 || progress > 1) return false;
	const top = origin.y + (target.top - 8 - origin.y) * progress;
	const bottom = origin.y + (target.bottom + 8 - origin.y) * progress;
	return point.y >= Math.min(top, bottom) - 2 && point.y <= Math.max(top, bottom) + 2;
}

let activePreview: ConversationPreviewInteraction | undefined;

/** Owns preview timing and focus return; never subscribes to conversation execution. */
export class ConversationPreviewInteraction {
	mode: PreviewMode = "closed";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private restoreFocus = false;
	private readonly overlays = new Set<"menu" | "dialog">();
	private readonly change: (mode: PreviewMode) => void;

	constructor(change: (mode: PreviewMode) => void) {
		this.change = change;
	}

	cancelPending() {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	enter(immediate = false) {
		this.cancelPending();
		if (this.mode !== "closed" || this.overlays.size > 0) return;
		if (immediate) this.setMode("hover");
		else this.timer = setTimeout(() => this.setMode("hover"), 200);
	}

	setOverlayOpen(owner: "menu" | "dialog", open: boolean) {
		if (open) {
			this.overlays.add(owner);
			this.close("navigate");
		} else this.overlays.delete(owner);
	}

	leave() {
		this.cancelPending();
		if (this.mode !== "hover") return;
		this.timer = setTimeout(() => this.close(), 100);
	}

	pin() {
		if (this.overlays.size > 0) return;
		this.restoreFocus = true;
		this.setMode("pinned");
	}

	activate() {
		if (this.overlays.size > 0) return;
		this.restoreFocus = true;
		this.setMode(this.mode === "pinned" ? "closed" : "pinned");
	}

	close(reason: "dismiss" | "navigate" = "dismiss") {
		if (reason === "navigate") this.restoreFocus = false;
		this.setMode("closed");
	}

	consumeFocusReturn() {
		const restore = this.restoreFocus;
		this.restoreFocus = false;
		return restore;
	}

	release() {
		this.close("navigate");
	}

	private setMode(mode: PreviewMode) {
		this.cancelPending();
		if (mode === this.mode) return;
		if (mode !== "closed") {
			if (activePreview && activePreview !== this) activePreview.close("navigate");
			activePreview = this;
		} else if (activePreview === this) activePreview = undefined;
		this.mode = mode;
		this.change(mode);
	}
}
