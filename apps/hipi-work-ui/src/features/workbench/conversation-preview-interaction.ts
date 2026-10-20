export type PreviewMode = "closed" | "hover" | "pinned";

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

	enter() {
		this.cancelPending();
		if (this.mode !== "closed" || this.overlays.size > 0) return;
		this.timer = setTimeout(() => this.setMode("hover"), 350);
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
		this.timer = setTimeout(() => this.close(), 200);
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

	private setMode(mode: PreviewMode) {
		this.cancelPending();
		if (mode === this.mode) return;
		this.mode = mode;
		this.change(mode);
	}
}
