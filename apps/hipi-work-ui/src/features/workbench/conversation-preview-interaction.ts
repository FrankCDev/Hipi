export type PreviewMode = "closed" | "hover" | "pinned";

/** Owns preview timing and focus return; never subscribes to conversation execution. */
export class ConversationPreviewInteraction {
	mode: PreviewMode = "closed";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private restoreFocus = false;
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
		if (this.mode !== "closed") return;
		this.timer = setTimeout(() => this.setMode("hover"), 350);
	}

	leave() {
		this.cancelPending();
		if (this.mode !== "hover") return;
		this.timer = setTimeout(() => this.close(), 200);
	}

	pin() {
		this.restoreFocus = true;
		this.setMode("pinned");
	}

	activate() {
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
