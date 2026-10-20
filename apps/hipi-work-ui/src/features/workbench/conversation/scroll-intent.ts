export const CONVERSATION_END_THRESHOLD = 24;
export const CONVERSATION_HISTORY_THRESHOLD = 64;
export const CONVERSATION_JUMP_DURATION = 260;
export const TOUCH_INTENT_THRESHOLD = 8;
const INTENT_FRESHNESS = 1000;

type ScrollPorts = {
	offset: () => number;
	end: () => number;
	move: (offset: number) => void;
	finish: () => void;
	cancel: () => void;
	follow: (following: boolean) => void;
	nearEnd: (near: boolean) => void;
	reducedMotion: () => boolean;
	frame: (callback: (time: number) => void) => number;
	cancelFrame: (frame: number) => void;
	now: () => number;
};

/**
 * User intent and numerical proximity are separate. In particular, a wheel-up
 * gesture at the last line must stop growth following before it leaves 24px.
 * Owns only the cancellable jump; native scrolling is never prevented.
 */
export class ConversationScrollIntent {
	private readonly ports: ScrollPorts;
	private following = true;
	private near = true;
	private direction = 0;
	private intentAt = Number.NEGATIVE_INFINITY;
	private frameId: number | undefined;
	private settling = false;
	private disposed = false;

	constructor(ports: ScrollPorts) {
		this.ports = ports;
	}

	get follows() {
		return this.following;
	}

	get jumping() {
		return this.frameId !== undefined;
	}

	setFollow(value: boolean) {
		if (this.following === value) return;
		this.following = value;
		this.ports.follow(value);
	}

	/** Direction follows scrollTop: negative reads earlier, positive reads later. */
	userIntent(direction: number) {
		if (this.disposed) return;
		this.direction = Math.sign(direction);
		this.intentAt = this.ports.now();
		this.cancelJump();
		this.setFollow(false);
	}

	scrolled() {
		if (this.disposed) return;
		const near = this.ports.end() - this.ports.offset() <= CONVERSATION_END_THRESHOLD;
		if (near !== this.near) {
			this.near = near;
			this.ports.nearEnd(near);
		}
		if (this.jumping || this.settling) {
			if (near) this.settling = false;
			return;
		}
		if (!near) this.setFollow(false);
		else if (this.direction > 0 && this.ports.now() - this.intentAt <= INTENT_FRESHNESS) this.setFollow(true);
	}

	jump() {
		if (this.disposed) return;
		this.cancelJump();
		this.direction = 0;
		const start = this.ports.offset();
		if (this.ports.reducedMotion() || this.ports.end() - start <= CONVERSATION_END_THRESHOLD) {
			this.settling = true;
			this.setFollow(true);
			this.ports.finish();
			return;
		}
		// Following is enabled at completion, not during the animation. Row resize
		// notifications therefore cannot race the explicit animated position.
		this.setFollow(false);
		const started = this.ports.now();
		const step = (time: number) => {
			if (this.disposed) return;
			const progress = Math.min(1, Math.max(0, (time - started) / CONVERSATION_JUMP_DURATION));
			const eased = 1 - (1 - progress) ** 3;
			this.ports.move(start + (this.ports.end() - start) * eased);
			if (progress < 1) this.frameId = this.ports.frame(step);
			else {
				this.frameId = undefined;
				this.settling = true;
				this.setFollow(true);
				this.ports.finish();
			}
		};
		this.frameId = this.ports.frame(step);
	}

	cancelJump() {
		if (this.frameId !== undefined) this.ports.cancelFrame(this.frameId);
		this.frameId = undefined;
		this.settling = false;
		this.ports.cancel();
	}

	dispose() {
		this.disposed = true;
		this.cancelJump();
	}
}

/** Native scrolling keys, not application shortcuts. Never intercept controls. */
export function nativeScrollDirection(
	event: {
		key: string;
		shiftKey: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		defaultPrevented: boolean;
	},
	interactive: boolean,
): number | null {
	if (interactive || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return null;
	if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") return -1;
	if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End") return 1;
	if (event.key === " ") return event.shiftKey ? -1 : 1;
	return null;
}

export function isScrollbarPointer(
	clientX: number,
	rect: { left: number; right: number },
	clientLeft: number,
	clientWidth: number,
): boolean {
	const contentLeft = rect.left + clientLeft;
	return (
		clientX >= rect.left && clientX <= rect.right && (clientX < contentLeft || clientX >= contentLeft + clientWidth)
	);
}
