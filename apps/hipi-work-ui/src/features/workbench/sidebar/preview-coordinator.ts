export type PreviewOpenMode = "hover" | "pinned";

export type PreviewOwner = {
	show: (mode: PreviewOpenMode) => void;
	dismiss: () => void;
	hasCardFocus: () => boolean;
};

/** One navigation surface owns its warm period, pending intent and interactive card. */
export class SidebarPreviewCoordinator {
	private active: PreviewOwner | undefined;
	private pending: { owner: PreviewOwner; timer: ReturnType<typeof setTimeout> } | undefined;
	private corridor: PreviewOwner | undefined;
	private readonly blocked = new Set<PreviewOwner>();
	private warm = false;
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	private enabled = true;

	enter(owner: PreviewOwner, immediate = false, focus = false) {
		if (!this.admits(owner, focus)) return;
		if (this.active === owner) return;
		// Pointer moves retry a corridor-blocked handoff, but cannot restart a cold deadline.
		if (this.pending?.owner === owner && !immediate) return;
		this.clearPending();
		if (immediate || this.warm) this.open(owner, "hover", focus);
		else {
			this.pending = {
				owner,
				timer: setTimeout(() => {
					if (this.pending?.owner !== owner) return;
					this.pending = undefined;
					this.open(owner, "hover", focus);
				}, 200),
			};
		}
	}

	open(owner: PreviewOwner, mode: PreviewOpenMode, focus = true) {
		if (!this.admits(owner, focus)) return false;
		this.clearPending();
		clearTimeout(this.warmTimer);
		this.warmTimer = undefined;
		this.warm = true;
		const previous = this.active;
		this.active = owner;
		this.corridor = undefined;
		// Change ownership before closing the peer: its cleanup must not retire this card.
		if (previous && previous !== owner) previous.dismiss();
		owner.show(mode);
		return true;
	}

	cancelPending(owner: PreviewOwner) {
		if (this.pending?.owner === owner) this.clearPending();
	}

	holdCorridor(owner: PreviewOwner, hold: boolean) {
		if (hold && this.active === owner) this.corridor = owner;
		else if (!hold && this.corridor === owner) this.corridor = undefined;
	}

	close(owner: PreviewOwner) {
		this.cancelPending(owner);
		if (this.active !== owner) return;
		this.active = undefined;
		this.corridor = undefined;
		clearTimeout(this.warmTimer);
		this.warmTimer = setTimeout(() => {
			this.warm = false;
			this.warmTimer = undefined;
		}, 300);
	}

	setBlocked(owner: PreviewOwner, blocked: boolean) {
		if (blocked) {
			this.blocked.add(owner);
			this.reset();
		} else this.blocked.delete(owner);
	}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		if (!enabled) this.reset();
	}

	reset() {
		this.clearPending();
		const active = this.active;
		this.active = undefined;
		this.corridor = undefined;
		clearTimeout(this.warmTimer);
		this.warmTimer = undefined;
		this.warm = false;
		active?.dismiss();
	}

	release(owner: PreviewOwner) {
		this.cancelPending(owner);
		this.blocked.delete(owner);
		if (this.active === owner) this.reset();
	}

	dispose() {
		this.setEnabled(false);
		this.blocked.clear();
	}

	private admits(owner: PreviewOwner, focus: boolean) {
		return (
			this.enabled &&
			this.blocked.size === 0 &&
			(focus || !this.active || this.active === owner || (!this.corridor && !this.active.hasCardFocus()))
		);
	}

	private clearPending() {
		clearTimeout(this.pending?.timer);
		this.pending = undefined;
	}
}
