import type { EditorState } from "@codemirror/state";
import type { EditState } from "@pierre/diffs/edit";
import type { FileSearchMemory } from "./file-search.tsx";

/** A bounded tab owns its view state; hiding the view never discards undo history or selection. */
export type EditorViewMemory = {
	captureView?: () => { scrollTop: number; scrollLeft: number };
	mode?: "source" | "preview" | "diff";
	state?: EditorState;
	pierre?: EditState<"file", undefined>;
	scrollTop?: number;
	scrollLeft?: number;
	search?: FileSearchMemory;
	markdownPreview?: { scrollTop: number; scrollLeft: number };
};
