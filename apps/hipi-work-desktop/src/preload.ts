import { AppError, parseRequest } from "@hipi/work-runtime/contracts";
import { FileServiceError } from "@hipi/work-runtime/files";
import { parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { contextBridge, ipcRenderer } from "electron";
import { CREDENTIAL_CHANNEL, credentialRequest } from "./credential-protocol.ts";
import { FILE_CHANNEL, FILE_ROOT_CHANNEL, rootRequest } from "./file-protocol.ts";
import { InvocationGate } from "./invocation-gate.ts";
import { PREVIEW_CANCEL_CHANNEL, PREVIEW_CHANNEL } from "./preview-protocol.ts";
import { CHANNEL, decode, encode, identifier, MAX_ACTIVE, observation } from "./protocol.ts";

const subscriptions = new Map<string, (value: unknown) => void | Promise<void>>();
const gate = new InvocationGate();
const credentialGate = new InvocationGate();
const fileGate = new InvocationGate();
const previewCalls = new Set<string>();
contextBridge.exposeInMainWorld(
	"hipiWorkPreviews",
	Object.freeze({
		async request(rawId: unknown, raw: unknown): Promise<unknown> {
			const id = identifier(rawId);
			const request = parsePreviewRequest(raw);
			if (previewCalls.has(id)) throw new FileServiceError("INVALID_PATH");
			if (previewCalls.size >= MAX_ACTIVE) throw new FileServiceError("BUSY");
			previewCalls.add(id);
			try {
				return await ipcRenderer.invoke(PREVIEW_CHANNEL, encode({ id, request }));
			} finally {
				previewCalls.delete(id);
			}
		},
		cancel(rawId: unknown): void {
			const id = identifier(rawId);
			if (previewCalls.has(id)) ipcRenderer.send(PREVIEW_CANCEL_CHANNEL, encode({ id }));
		},
	}),
);
contextBridge.exposeInMainWorld(
	"hipiWorkFiles",
	Object.freeze({
		async request(raw: unknown): Promise<unknown> {
			const request = parseFileRequest(raw);
			return fileGate.run(() => ipcRenderer.invoke(FILE_CHANNEL, encode(request)));
		},
		async manage(raw: unknown): Promise<unknown> {
			const request = rootRequest(raw);
			return fileGate.run(() => ipcRenderer.invoke(FILE_ROOT_CHANNEL, encode(request)));
		},
	}),
);
contextBridge.exposeInMainWorld(
	"hipiWorkCredentials",
	Object.freeze({
		async request(raw: unknown): Promise<unknown> {
			const request = credentialRequest(raw);
			return credentialGate.run(() => ipcRenderer.invoke(CREDENTIAL_CHANNEL, encode(request)));
		},
	}),
);
ipcRenderer.on(CHANNEL, (_event, raw: unknown) => {
	let id: string;
	let value: Record<string, unknown>;
	try {
		value = decode(raw);
		id = identifier(value.id);
	} catch {
		return;
	}
	const listener = subscriptions.get(id);
	if (!listener) return;
	if (value.kind === "status") {
		subscriptions.delete(id);
		void Promise.resolve()
			.then(() => listener({ kind: "status", status: value.status }))
			.catch(() => undefined);
		return;
	}
	if (value.kind !== "frame") return;
	void Promise.resolve()
		.then(() => listener({ kind: "frame", frame: value.frame }))
		.then(
			() => {
				if (subscriptions.has(id)) ipcRenderer.send(CHANNEL, encode({ kind: "ack", id }));
			},
			() => {
				subscriptions.delete(id);
				ipcRenderer.send(CHANNEL, encode({ kind: "cancel", id }));
			},
		)
		.catch(() => subscriptions.delete(id));
});
contextBridge.exposeInMainWorld(
	"hipiWorkDesktop",
	Object.freeze({
		async request(raw: unknown): Promise<unknown> {
			const request = parseRequest(raw);
			return gate.run(() => ipcRenderer.invoke(CHANNEL, encode(request)));
		},
		subscribe(raw: unknown, listener: (value: unknown) => void | Promise<void>): () => void {
			const input = observation(raw);
			if (typeof listener !== "function") throw new AppError("INVALID_REQUEST");
			if (subscriptions.size >= MAX_ACTIVE) throw new AppError("CAPACITY_EXCEEDED");
			const id = crypto.randomUUID();
			subscriptions.set(id, listener);
			try {
				ipcRenderer.send(CHANNEL, encode({ kind: "observe", id, input }));
			} catch (error) {
				subscriptions.delete(id);
				throw error;
			}
			return () => {
				if (!subscriptions.delete(id)) return;
				try {
					ipcRenderer.send(CHANNEL, encode({ kind: "cancel", id }));
				} catch {
					/* Renderer IPC is already gone. */
				}
			};
		},
	}),
);
