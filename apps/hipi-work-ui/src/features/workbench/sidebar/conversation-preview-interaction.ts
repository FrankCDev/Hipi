import { type PreviewOwner, SidebarPreviewCoordinator } from "./preview-coordinator.ts";

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

/** Owns preview timing and focus return; never subscribes to conversation execution. */
export class ConversationPreviewInteraction {
	mode: PreviewMode = "closed";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private restoreFocus = false;
	private released = false;
	private readonly overlays = new Set<"menu" | "dialog">();
	private readonly change: (mode: PreviewMode) => void;
	private readonly coordinator: SidebarPreviewCoordinator;
	private readonly owner: PreviewOwner;

	constructor(
		change: (mode: PreviewMode) => void,
		coordinator = new SidebarPreviewCoordinator(),
		hasCardFocus = () => false,
	) {
		this.change = change;
		this.coordinator = coordinator;
		this.owner = { show: (mode) => this.setMode(mode), dismiss: () => this.close("navigate"), hasCardFocus };
	}

	cancelPending() {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.coordinator.cancelPending(this.owner);
	}

	enter(immediate = false, focus = false) {
		if (this.released) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.mode !== "closed" || this.overlays.size > 0) return;
		this.coordinator.enter(this.owner, immediate, focus);
	}

	holdCorridor(hold: boolean) {
		this.coordinator.holdCorridor(this.owner, hold);
	}

	setOverlayOpen(owner: "menu" | "dialog", open: boolean) {
		if (this.released) return;
		if (open) this.overlays.add(owner);
		else this.overlays.delete(owner);
		this.coordinator.setBlocked(this.owner, this.overlays.size > 0);
		if (open) this.close("navigate");
	}

	leave() {
		this.cancelPending();
		if (this.mode !== "hover") return;
		this.timer = setTimeout(() => this.close(), 100);
	}

	pin() {
		if (this.released || this.overlays.size > 0) return;
		if (this.coordinator.open(this.owner, "pinned")) this.restoreFocus = true;
	}

	activate() {
		if (this.released || this.overlays.size > 0) return;
		if (this.mode === "pinned") this.close();
		else this.pin();
	}

	close(reason: "dismiss" | "navigate" = "dismiss") {
		if (reason === "navigate") this.restoreFocus = false;
		this.coordinator.close(this.owner);
		this.setMode("closed");
	}

	consumeFocusReturn() {
		const restore = this.restoreFocus;
		this.restoreFocus = false;
		return restore;
	}

	release() {
		this.coordinator.release(this.owner);
		this.overlays.clear();
		this.close("navigate");
		this.released = true;
	}

	resume() {
		this.released = false;
	}

	private setMode(mode: PreviewMode) {
		this.cancelPending();
		if (mode === this.mode) return;
		this.mode = mode;
		this.change(mode);
	}
}
