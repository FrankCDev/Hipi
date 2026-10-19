import type { LocalState } from "./local-state.ts";

export const FILE_PANEL = { min: 320, max: 720, initial: 420, conversationMin: 480, handle: 8 } as const;
export function validPanelWidth(value: string): boolean {
	return /^\d{3}$/.test(value) && Number(value) >= FILE_PANEL.min && Number(value) <= FILE_PANEL.max;
}
/** Measure the work area, excluding navigation, rather than guessing from viewport breakpoints. */
export function panelLayout(available: number, preferred: number) {
	const safe = Number.isFinite(available) ? Math.max(0, available) : 0;
	const max = Math.min(
		FILE_PANEL.max,
		Math.max(FILE_PANEL.min, Math.floor(safe - FILE_PANEL.conversationMin - FILE_PANEL.handle)),
	);
	return {
		overlay: safe < FILE_PANEL.min + FILE_PANEL.conversationMin + FILE_PANEL.handle,
		max,
		width: Math.round(
			Math.min(max, Math.max(FILE_PANEL.min, Number.isFinite(preferred) ? preferred : FILE_PANEL.initial)),
		),
	};
}
/** Presentation preferences only. Editor buffers and file operations belong to Workbench's EditorSession. */
export class FilePanelController {
	private local: Pick<LocalState, "read" | "write">;
	private state: { open: boolean; width: number; storageFailed: boolean };
	private listeners = new Set<() => void>();
	constructor(local: Pick<LocalState, "read" | "write">) {
		this.local = local;
		const width = local.read("file-panel.width") ?? "";
		this.state = {
			open: local.read("file-panel.open") === "true",
			width: validPanelWidth(width) ? Number(width) : FILE_PANEL.initial,
			storageFailed: false,
		};
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	setOpen(open: boolean) {
		this.state = { ...this.state, open, storageFailed: !this.local.write("file-panel.open", String(open)) };
		for (const listener of this.listeners) listener();
	}
	resize(width: number, available: number, persist = true) {
		const next = panelLayout(available, width).width;
		this.state = {
			...this.state,
			width: next,
			storageFailed: persist ? !this.local.write("file-panel.width", String(next)) : this.state.storageFailed,
		};
		for (const listener of this.listeners) listener();
	}
}
