import {
	AppearanceError,
	parseAppearanceReply,
	parseAppearanceRequest,
	parseAppearanceStatus,
	parseFontReply,
} from "@hipi/work-runtime/appearance";
import { AppError, parseRequest } from "@hipi/work-runtime/contracts";
import { FileServiceError } from "@hipi/work-runtime/files";
import { parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { contextBridge, ipcRenderer } from "electron";
import {
	APPEARANCE_CHANNEL,
	APPEARANCE_UPDATED,
	decodeFontRequest,
	FONT_CANCEL_CHANNEL,
	FONT_CHANNEL,
} from "./appearance/protocol.ts";
import { CREDENTIAL_CHANNEL, credentialRequest } from "./credentials/protocol.ts";
import { FILE_CHANNEL, FILE_ROOT_CHANNEL, rootRequest } from "./files/protocol.ts";
import { InvocationGate } from "./ipc/invocation-gate.ts";
import { CHANNEL, decode, encode, identifier, MAX_ACTIVE, observation } from "./ipc/protocol.ts";
import { PREVIEW_CANCEL_CHANNEL, PREVIEW_CHANNEL } from "./previews/protocol.ts";

const subscriptions = new Map<string, (value: unknown) => void | Promise<void>>();
const gate = new InvocationGate();
const credentialGate = new InvocationGate();
const fileGate = new InvocationGate();
const previewCalls = new Set<string>();
let appearancePending = 0;
let fontPending: string | undefined;
const appearanceListeners = new Set<(status: unknown) => void>();
ipcRenderer.on(APPEARANCE_UPDATED, (_event, raw: unknown) => {
	try {
		const status = parseAppearanceStatus(raw);
		for (const listener of appearanceListeners) {
			try {
				listener(status);
			} catch {
				// A failed consumer cannot prevent other listeners from updating.
			}
		}
	} catch {
		// Ignore malformed unsolicited updates.
	}
});
contextBridge.exposeInMainWorld(
	"hipiWorkAppearance",
	Object.freeze({
		async request(raw: unknown): Promise<unknown> {
			const request = parseAppearanceRequest(raw);
			if (appearancePending >= 4) return { ok: false, error: "BUSY" };
			appearancePending++;
			try {
				const response: unknown = await ipcRenderer.invoke(APPEARANCE_CHANNEL, JSON.stringify(request));
				parseAppearanceReply(response);
				return response;
			} catch (error) {
				return { ok: false, error: error instanceof AppearanceError ? error.code : "FAILED" };
			} finally {
				appearancePending--;
			}
		},
		fontsSupported: ["darwin", "win32", "linux"].includes(process.platform),
		async listFonts(rawId: unknown): Promise<unknown> {
			const id = decodeFontRequest(JSON.stringify({ version: 1, id: rawId }));
			if (fontPending) return { ok: false, error: "BUSY" };
			fontPending = id;
			try {
				const response: unknown = await ipcRenderer.invoke(FONT_CHANNEL, JSON.stringify({ version: 1, id }));
				parseFontReply(response);
				return response;
			} catch (error) {
				return { ok: false, error: error instanceof AppearanceError ? error.code : "FAILED" };
			} finally {
				if (fontPending === id) fontPending = undefined;
			}
		},
		cancelFonts(rawId: unknown): void {
			const id = decodeFontRequest(JSON.stringify({ version: 1, id: rawId }));
			if (fontPending === id) ipcRenderer.send(FONT_CANCEL_CHANNEL, JSON.stringify({ version: 1, id }));
		},
		subscribe(listener: (status: unknown) => void): () => void {
			if (typeof listener !== "function" || appearanceListeners.size >= 4) throw new TypeError("Invalid listener");
			appearanceListeners.add(listener);
			return () => appearanceListeners.delete(listener);
		},
	}),
);
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
