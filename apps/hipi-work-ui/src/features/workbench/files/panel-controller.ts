import { createStore, type StoreApi } from "zustand/vanilla";
import type { LocalState } from "../local-state.ts";

export const FILE_PANEL = { min: 320, collapse: 160, initial: 640, conversationMin: 352, handle: 1 } as const;
export function validPanelWidth(value: string): boolean {
	// Legacy pixel records were written only in this range; new resizes persist a ratio.
	return /^\d{3}$/.test(value) && Number(value) >= FILE_PANEL.min && Number(value) <= 720;
}
export function validPanelRatio(value: string): boolean {
	return /^(0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value);
}
/** Measure the work area, excluding navigation, rather than guessing from viewport breakpoints. */
export function panelLayout(available: number, preferred: number, ratio?: number) {
	const safe = Number.isFinite(available) ? Math.max(0, available) : 0;
	const max = Math.max(FILE_PANEL.min, Math.floor(safe - FILE_PANEL.conversationMin - FILE_PANEL.handle));
	const desired = ratio !== undefined && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? safe * ratio : preferred;
	return {
		overlay: safe < FILE_PANEL.min + FILE_PANEL.conversationMin + FILE_PANEL.handle,
		max,
		width: Math.round(Math.min(max, Math.max(FILE_PANEL.min, Number.isFinite(desired) ? desired : FILE_PANEL.initial))),
	};
}
type PanelState = Readonly<{
	open: boolean;
	fullWidth: boolean;
	width: number;
	ratio?: number;
	storageFailed: boolean;
}>;

/** One instance per connection-scoped LocalState. Editor buffers and file operations have separate owners. */
export class FilePanelController {
	private readonly local: Pick<LocalState, "read" | "write">;
	private readonly writableStore: StoreApi<PanelState>;
	readonly store: Pick<StoreApi<PanelState>, "getState" | "getInitialState" | "subscribe">;
	private resizeStart: PanelState | undefined;
	constructor(local: Pick<LocalState, "read" | "write">) {
		this.local = local;
		const width = local.read("file-panel.width") ?? "";
		const ratio = local.read("file-panel.ratio") ?? "";
		this.writableStore = createStore<PanelState>(() => ({
			open: local.read("file-panel.open") === "true",
			fullWidth: false,
			width: validPanelWidth(width) ? Number(width) : FILE_PANEL.initial,
			...(validPanelRatio(ratio) ? { ratio: Number(ratio) } : {}),
			storageFailed: false,
		}));
		this.store = {
			getState: this.writableStore.getState,
			getInitialState: this.writableStore.getInitialState,
			subscribe: this.writableStore.subscribe,
		};
	}
	setOpen(open: boolean) {
		this.resizeStart = undefined;
		this.writableStore.setState({
			open,
			fullWidth: false,
			storageFailed: !this.local.write("file-panel.open", String(open)),
		});
	}
	resize(width: number, available: number, persist = true) {
		const next = panelLayout(available, width).width;
		const ratio = Number.isFinite(available) && available > 0 ? Math.min(1, next / available) : undefined;
		this.writableStore.setState({
			fullWidth: false,
			width: next,
			ratio,
			storageFailed:
				persist && ratio !== undefined
					? !this.local.write("file-panel.ratio", ratio.toFixed(6))
					: this.writableStore.getState().storageFailed,
		});
	}
	/** A gesture may preview sizes, but collapsed/full presentations retain its original split preference. */
	beginResize() {
		this.resizeStart ??= this.writableStore.getState();
	}
	resizeFromSplitter(width: number, available: number, persist = true) {
		if (!Number.isFinite(width) || !Number.isFinite(available) || available <= 0) return;
		const layout = panelLayout(available, width);
		if (layout.overlay) return;
		const collapsed = width < FILE_PANEL.collapse;
		const fullWidth = width > layout.max && available - width < FILE_PANEL.collapse;
		if (!collapsed && !fullWidth) {
			this.resize(width, available, persist);
			return;
		}
		const preferred = this.resizeStart ?? this.writableStore.getState();
		this.writableStore.setState({
			open: !collapsed,
			fullWidth,
			width: preferred.width,
			ratio: preferred.ratio,
			storageFailed: persist
				? !this.local.write("file-panel.open", String(!collapsed))
				: this.writableStore.getState().storageFailed,
		});
	}
	finishResize(cancel = false) {
		const start = this.resizeStart;
		this.resizeStart = undefined;
		if (!start) return;
		if (cancel) this.writableStore.setState(start, true);
		else {
			const state = this.writableStore.getState();
			const openSaved = this.local.write("file-panel.open", String(state.open));
			const ratioSaved =
				!state.open || state.fullWidth || state.ratio === undefined
					? true
					: this.local.write("file-panel.ratio", state.ratio.toFixed(6));
			this.writableStore.setState({ storageFailed: !openSaved || !ratioSaved });
		}
	}
	restoreSplit() {
		this.writableStore.setState({ fullWidth: false });
	}
}
