import {
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	type Request,
	type ToolPackMutationMethod,
	toolPackCommandPayload,
} from "@hipi/work-runtime/contracts";
import type { LocalState } from "../workbench/local-state.ts";

export type PackCommand = Extract<Request, { method: ToolPackMutationMethod }>;
export type PendingPackCommand = {
	lookup: Params<"getToolPackCommandResult">;
	command: Exclude<PackCommand, { method: "installToolPack" }> | null;
	install: Omit<Params<"installToolPack">, "packageText"> | null;
};
export function validatePackageText(text: string) {
	if (
		!text ||
		text.startsWith("\ufeff") ||
		/[\ud800-\udfff]/u.test(text) ||
		new TextEncoder().encode(text).byteLength > 65536
	)
		throw new Error("INVALID_PACKAGE_TEXT");
}
export async function sha256(text: string) {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function pendingCommand(command: PackCommand): Promise<PendingPackCommand> {
	const requestDigest = await sha256(toolPackCommandPayload(command.method, command.params));
	const lookup = parseRequest({
		version: PROTOCOL_VERSION,
		method: "getToolPackCommandResult",
		params: {
			method: command.method,
			workspaceId: command.params.workspaceId,
			requestId: command.params.requestId,
			requestDigest,
			...("conversationId" in command.params ? { conversationId: command.params.conversationId } : {}),
		},
	});
	if (lookup.method !== "getToolPackCommandResult") throw new Error("INVALID_LOOKUP");
	if (command.method === "installToolPack") {
		const { packageText: _text, ...install } = command.params;
		return { lookup: lookup.params, command: null, install };
	}
	return { lookup: lookup.params, command, install: null };
}
export function savePackCommand(local: LocalState, key: string, pending: PendingPackCommand | null) {
	// Package source is deliberately never persisted in renderer storage.
	if (
		!local.write(key, pending ? JSON.stringify({ version: 1, pending }) : JSON.stringify({ version: 2, request: null }))
	)
		throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
}
export function readPackCommand(
	local: LocalState,
	key: string,
): { pending: PendingPackCommand | null; incompatible: boolean } {
	const raw = local.read(key);
	if (!raw || raw === JSON.stringify({ version: 2, request: null })) return { pending: null, incompatible: false };
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("pending" in value))
			throw new Error();
		const pending = value.pending;
		if (
			!pending ||
			typeof pending !== "object" ||
			!("lookup" in pending) ||
			!("command" in pending) ||
			!("install" in pending)
		)
			throw new Error();
		const lookup = parseRequest({
			version: PROTOCOL_VERSION,
			method: "getToolPackCommandResult",
			params: pending.lookup,
		});
		if (lookup.method !== "getToolPackCommandResult") throw new Error();
		if (lookup.params.method === "installToolPack") {
			if (
				pending.command !== null ||
				!pending.install ||
				typeof pending.install !== "object" ||
				"packageText" in pending.install
			)
				throw new Error();
			const parsed = parseRequest({
				version: PROTOCOL_VERSION,
				method: "installToolPack",
				params: { ...pending.install, packageText: "{}" },
			});
			if (parsed.method !== "installToolPack") throw new Error();
			const { packageText: _text, ...install } = parsed.params;
			if (install.workspaceId !== lookup.params.workspaceId || install.requestId !== lookup.params.requestId)
				throw new Error();
			return { pending: { lookup: lookup.params, command: null, install }, incompatible: false };
		}
		const command = parseRequest(pending.command);
		if (
			command.expectedStoreId !== undefined ||
			pending.install !== null ||
			command.method !== lookup.params.method ||
			!("requestId" in command.params) ||
			command.params.requestId !== lookup.params.requestId ||
			command.params.workspaceId !== lookup.params.workspaceId
		)
			throw new Error();
		if (
			command.method !== "setToolPackEnabled" &&
			command.method !== "uninstallToolPack" &&
			command.method !== "bindToolPack" &&
			command.method !== "revokeToolPackBinding" &&
			command.method !== "authorizeRetainedToolPack"
		)
			throw new Error();
		if (
			"conversationId" in lookup.params &&
			(!("conversationId" in command.params) || command.params.conversationId !== lookup.params.conversationId)
		)
			throw new Error();
		return { pending: { lookup: lookup.params, command, install: null }, incompatible: false };
	} catch {
		return { pending: null, incompatible: true };
	}
}
