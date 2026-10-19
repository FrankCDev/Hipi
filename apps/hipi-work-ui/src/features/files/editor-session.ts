import {
	type EditorDiffBaseline,
	FILE_LIMITS,
	FileServiceError,
	type FileTarget,
	type FileText,
} from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";

export type ArtifactReference = { operationId: string; expectedRevision?: string };
export type EditorDocument = {
	target: FileTarget;
	baseline: FileText;
	diffBaseline: EditorDiffBaseline;
	text: string;
	writable: boolean;
	artifactReference?: ArtifactReference;
};
export type EditorSnapshot = {
	document?: EditorDocument;
	operation?: "read" | "save" | "compare";
	error?: string;
	disk?: FileText;
	diskTarget?: FileTarget;
	unknown?: string;
	artifactRequest?: ArtifactReference;
};
/** Owns only the unsaved editor buffer. Runtime versions remain authoritative. */
export class EditorSession {
	private state: EditorSnapshot = {};
	private listeners = new Set<() => void>();
	private pending?: AbortController;
	private generation = 0;
	private closed = false;
	private client: FileClient;
	constructor(client: FileClient) {
		this.client = client;
	}
	/** Host effect setup may reactivate the same controller after a StrictMode cleanup. */
	activate() {
		this.closed = false;
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(state: EditorSnapshot) {
		if (this.closed) return;
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	get protected() {
		return (
			this.state.unknown !== undefined ||
			this.state.operation === "save" ||
			(!!this.state.document && this.state.document.text !== this.state.document.baseline.text)
		);
	}
	edit(text: string) {
		if (this.state.document && this.state.operation !== "save")
			this.publish({ ...this.state, document: { ...this.state.document, text } });
	}
	cancel() {
		this.pending?.abort();
		this.pending = undefined;
		this.generation++;
		this.publish({
			...this.state,
			operation: undefined,
			...(this.state.operation === "save"
				? { error: "WRITE_OUTCOME_UNKNOWN", unknown: this.state.document?.text }
				: {}),
		});
	}
	clear() {
		this.cancel();
		this.publish({});
	}
	/** Opens current authorized content, not a historical byte snapshot or a new file grant. */
	openArtifact(target: FileTarget, reference: ArtifactReference) {
		return this.open(target, undefined, reference);
	}
	async open(target: FileTarget, writable: boolean | undefined, reference?: ArtifactReference) {
		if (this.closed || this.protected) return;
		const selection = { workspaceId: target.workspaceId, rootId: target.rootId, path: target.path };
		const artifact = reference ? { ...reference } : undefined;
		this.cancel();
		const generation = ++this.generation;
		const controller = new AbortController();
		this.pending = controller;
		this.publish({ ...this.state, operation: "read", error: undefined, artifactRequest: artifact });
		try {
			let canWrite = writable;
			if (canWrite === undefined) {
				const roots = await this.client.listRoots(selection.workspaceId, controller.signal);
				if (generation !== this.generation || this.closed) return;
				const root = roots.find(
					(item) => item.workspaceId === selection.workspaceId && item.rootId === selection.rootId,
				);
				if (!root) throw new FileServiceError("UNAUTHORIZED");
				canWrite = root.writable;
			}
			const baseline = await this.client.readText(selection, controller.signal);
			if (generation === this.generation)
				this.publish({
					artifactRequest: artifact,
					document: {
						target: selection,
						writable: canWrite,
						baseline,
						diffBaseline: { kind: "editor-read", target: selection, revision: baseline.revision, text: baseline.text },
						text: baseline.text,
						...(artifact ? { artifactReference: artifact } : {}),
					},
				});
		} catch (error) {
			if (generation === this.generation)
				this.publish({
					...this.state,
					operation: undefined,
					error: error instanceof FileServiceError ? error.code : "IO_ERROR",
				});
		} finally {
			if (this.pending === controller) this.pending = undefined;
		}
	}
	async save() {
		if (this.closed) return;
		const document = this.state.document;
		if (
			!document ||
			!document.writable ||
			this.state.operation ||
			this.state.unknown !== undefined ||
			this.state.error === "VERSION_CONFLICT"
		)
			return;
		if (new TextEncoder().encode(document.text).length > FILE_LIMITS.bytes) {
			this.publish({ ...this.state, error: "LIMIT_EXCEEDED" });
			return;
		}
		const generation = ++this.generation;
		const controller = new AbortController();
		this.pending = controller;
		this.publish({ ...this.state, operation: "save", error: undefined, disk: undefined, diskTarget: undefined });
		try {
			const baseline = await this.client.saveText(
				document.target,
				document.text,
				document.baseline.revision,
				controller.signal,
			);
			if (generation === this.generation)
				this.publish({ document: { ...document, baseline, text: this.state.document?.text ?? document.text } });
		} catch (error) {
			if (generation !== this.generation) return;
			const code = error instanceof FileServiceError ? error.code : "WRITE_OUTCOME_UNKNOWN";
			this.publish({
				...this.state,
				operation: undefined,
				error: code,
				...(code === "WRITE_OUTCOME_UNKNOWN" ? { unknown: document.text } : {}),
			});
		} finally {
			if (this.pending === controller) this.pending = undefined;
		}
	}
	async compare() {
		if (this.closed) return;
		const document = this.state.document;
		if (!document || this.state.operation) return;
		const generation = ++this.generation;
		const controller = new AbortController();
		this.pending = controller;
		this.publish({ ...this.state, operation: "compare" });
		try {
			const disk = await this.client.readText(document.target, controller.signal);
			if (generation !== this.generation) return;
			if (this.state.unknown !== undefined && disk.text === this.state.unknown) {
				this.publish({
					document: { ...document, baseline: disk, text: this.state.document?.text ?? document.text },
					disk,
					diskTarget: document.target,
				});
			} else this.publish({ ...this.state, disk, diskTarget: document.target, operation: undefined });
		} catch (error) {
			if (generation === this.generation)
				this.publish({
					...this.state,
					operation: undefined,
					error: error instanceof FileServiceError ? error.code : "IO_ERROR",
				});
		} finally {
			if (this.pending === controller) this.pending = undefined;
		}
	}
	/** Adopt a reviewed disk version for the next conditional save; never merges or saves. */
	adoptComparedRevision(): boolean {
		const { document, disk, diskTarget, operation } = this.state;
		if (
			!document ||
			!disk ||
			!diskTarget ||
			operation ||
			this.pending ||
			document.target.workspaceId !== diskTarget.workspaceId ||
			document.target.rootId !== diskTarget.rootId ||
			document.target.path !== diskTarget.path
		)
			return false;
		this.publish({ document: { ...document, baseline: disk }, disk, diskTarget });
		return true;
	}
	/** Explicit discard is required before replacing the buffer, including after a conflict. */
	reload() {
		const document = this.state.document;
		if (!document || this.state.operation) return;
		this.clear();
		void this.open(document.target, document.writable);
	}
	dispose() {
		this.closed = true;
		this.pending?.abort();
		this.pending = undefined;
		this.generation++;
		this.listeners.clear();
		this.state = {};
	}
}
