export const COPY_FEEDBACK_MS = 1500;
export const COPY_TIMEOUT_MS = 10_000;
export type ClipboardStatus = "idle" | "copying" | "copied" | "failed";

export async function writeClipboard(text: string): Promise<void> {
	if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("Clipboard unavailable");
	await navigator.clipboard.writeText(text);
}

/** One clipboard attempt and one feedback timer; an expired write may still finish in the OS. */
export class ClipboardFeedback {
	private generation = 0;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private status: ClipboardStatus = "idle";
	private readonly publish: (status: ClipboardStatus) => void;
	private readonly write: (text: string) => Promise<void>;

	constructor(publish: (status: ClipboardStatus) => void, write = writeClipboard) {
		this.publish = publish;
		this.write = write;
	}

	copy(text: string) {
		if (this.disposed || this.status === "copying") return;
		clearTimeout(this.timer);
		const generation = ++this.generation;
		this.set("copying");
		this.timer = setTimeout(() => {
			this.generation++;
			this.set("failed");
		}, COPY_TIMEOUT_MS);
		void this.write(text).then(
			() => {
				if (this.disposed || generation !== this.generation) return;
				clearTimeout(this.timer);
				this.set("copied");
				this.timer = setTimeout(() => this.set("idle"), COPY_FEEDBACK_MS);
			},
			() => {
				if (this.disposed || generation !== this.generation) return;
				clearTimeout(this.timer);
				this.set("failed");
			},
		);
	}

	dispose() {
		this.disposed = true;
		this.generation++;
		clearTimeout(this.timer);
	}

	private set(status: ClipboardStatus) {
		if (this.disposed) return;
		this.status = status;
		this.publish(status);
	}
}
