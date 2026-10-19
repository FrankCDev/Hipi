import {
	type AppClient,
	type Params,
	PROTOCOL_VERSION,
	type Scope,
	type ToolPackBinding,
	type ToolPackCommandResult,
	type ToolPackPreview,
	type ToolPackRecord,
	toolPackCommandPayload,
} from "@hipi/work-runtime/contracts";
import type { LocalState } from "../workbench/local-state.ts";
import {
	type PackCommand,
	type PendingPackCommand,
	pendingCommand,
	readPackCommand,
	savePackCommand,
	sha256,
	validatePackageText,
} from "./recovery.ts";

export type PackState = {
	packs: ToolPackRecord[];
	packCursor: string | null;
	bindings: ToolPackBinding[];
	active: ToolPackBinding[];
	bindingCursor: string | null;
	history: boolean;
	busy: boolean;
	loaded: boolean;
	failed: boolean;
	incompatible: boolean;
	pending: PendingPackCommand | null;
	notFound: boolean;
	preview: { text: string; value: ToolPackPreview } | null;
	source: { digest: string; packageText: string } | null;
};
/** Owns one connection and scope. Closing a dialog stops waiting, never replays a mutation. */
export class ToolPackSession {
	private client: AppClient;
	private local: LocalState;
	readonly workspaceId: string;
	readonly conversationId: string | undefined;
	private key: string;
	private request: AbortController | null = null;
	private disposed = false;
	private archived = false;
	private listeners = new Set<() => void>();
	private packPage: string | undefined;
	private bindingPage: string | undefined;
	private state: PackState;
	constructor(client: AppClient, local: LocalState, workspaceId: string, conversationId?: string) {
		this.client = client;
		this.local = local;
		this.workspaceId = workspaceId;
		this.conversationId = conversationId;
		this.key = conversationId
			? `command.tool-packs.conversation.${workspaceId}.${conversationId}`
			: `command.tool-packs.workspace.${workspaceId}`;
		const saved = readPackCommand(local, this.key);
		const mismatch = saved.pending && !this.inScope(saved.pending.lookup);
		this.state = {
			packs: [],
			packCursor: null,
			bindings: [],
			active: [],
			bindingCursor: null,
			history: false,
			busy: false,
			loaded: false,
			failed: false,
			incompatible: saved.incompatible || !!mismatch,
			pending: mismatch ? null : saved.pending,
			notFound: false,
			preview: null,
			source: null,
		};
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	setArchived(value: boolean) {
		this.archived = value;
	}
	private inScope(value: { workspaceId: string; conversationId?: string }) {
		return (
			value.workspaceId === this.workspaceId &&
			(value.conversationId === undefined || value.conversationId === this.conversationId)
		);
	}
	private publish(patch: Partial<PackState>) {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private async run(work: (signal: AbortSignal) => Promise<void>) {
		if (this.disposed || this.request) return;
		const request = new AbortController();
		this.request = request;
		this.publish({ busy: true, failed: false });
		const timeout = setTimeout(() => request.abort(), 15000);
		let aborted: (() => void) | undefined;
		try {
			await Promise.race([
				work(request.signal),
				new Promise<never>((_, reject) => {
					aborted = () => reject(new Error("WAIT_ABORTED"));
					request.signal.addEventListener("abort", aborted, { once: true });
				}),
			]);
		} catch {
			if (this.request === request) this.publish({ failed: true });
		} finally {
			clearTimeout(timeout);
			if (aborted) request.signal.removeEventListener("abort", aborted);
			if (this.request === request) {
				this.request = null;
				this.publish({ busy: false });
			}
		}
	}
	private matches(pending: PendingPackCommand, receipt: ToolPackCommandResult) {
		const lookup = pending.lookup;
		return (
			receipt.method === lookup.method &&
			receipt.requestDigest === lookup.requestDigest &&
			receipt.scope.workspaceId === lookup.workspaceId &&
			receipt.result.workspaceId === lookup.workspaceId &&
			("conversationId" in lookup
				? "conversationId" in receipt.scope &&
					receipt.scope.conversationId === lookup.conversationId &&
					"conversationId" in receipt.result &&
					receipt.result.conversationId === lookup.conversationId
				: !("conversationId" in receipt.scope))
		);
	}
	private async lookup(signal: AbortSignal) {
		const pending = this.state.pending;
		if (!pending) return;
		const receipt = await this.client.call("getToolPackCommandResult", pending.lookup, signal);
		signal.throwIfAborted();
		if (!receipt) {
			this.publish({ notFound: true });
			return;
		}
		if (!this.matches(pending, receipt)) throw new Error("COMMAND_MISMATCH");
		savePackCommand(this.local, this.key, null);
		this.publish({ pending: null, notFound: false });
	}
	private async read(signal: AbortSignal) {
		const packs = await this.client.call(
			"listToolPacks",
			{ workspaceId: this.workspaceId, ...(this.packPage ? { cursor: this.packPage } : {}) },
			signal,
		);
		signal.throwIfAborted();
		if (packs.items.some((pack) => pack.workspaceId !== this.workspaceId)) throw new Error("SCOPE_MISMATCH");
		let bindings: ToolPackBinding[] = [];
		let active: ToolPackBinding[] = [];
		let bindingCursor: string | null = null;
		if (this.conversationId) {
			const scope: Scope = { workspaceId: this.workspaceId, conversationId: this.conversationId };
			active = await this.client.call("listActiveToolPackBindings", scope, signal);
			signal.throwIfAborted();
			if (this.state.history) {
				const page = await this.client.call(
					"listToolPackBindings",
					{ ...scope, ...(this.bindingPage ? { cursor: this.bindingPage } : {}) },
					signal,
				);
				signal.throwIfAborted();
				bindings = page.items;
				bindingCursor = page.nextCursor;
			} else bindings = active;
			if (
				[...bindings, ...active].some(
					(binding) => binding.workspaceId !== scope.workspaceId || binding.conversationId !== scope.conversationId,
				)
			)
				throw new Error("SCOPE_MISMATCH");
		}
		this.publish({ packs: packs.items, packCursor: packs.nextCursor, bindings, active, bindingCursor, loaded: true });
	}
	refresh = () =>
		this.run(async (signal) => {
			await this.lookup(signal);
			await this.read(signal);
		});
	pagePacks = (cursor?: string) => {
		if (this.state.busy) return Promise.resolve();
		this.packPage = cursor;
		return this.refresh();
	};
	pageBindings = (history: boolean, cursor?: string) => {
		if (this.state.busy) return Promise.resolve();
		this.bindingPage = cursor;
		this.publish({ history });
		return this.refresh();
	};
	preview = (text: string) =>
		this.run(async (signal) => {
			this.publish({ preview: null });
			validatePackageText(text);
			const value = await this.client.call(
				"previewToolPack",
				{ workspaceId: this.workspaceId, packageText: text },
				signal,
			);
			signal.throwIfAborted();
			if ((await sha256(text)) !== value.digest) throw new Error("SOURCE_MISMATCH");
			signal.throwIfAborted();
			this.publish({ preview: { text, value } });
		});
	clearPreview() {
		this.publish({ preview: null });
	}
	source = (digest: string) =>
		this.run(async (signal) => {
			this.publish({ source: null });
			const value = await this.client.call("getToolPackSource", { workspaceId: this.workspaceId, digest }, signal);
			signal.throwIfAborted();
			if (
				value.workspaceId !== this.workspaceId ||
				value.digest !== digest ||
				(await sha256(value.packageText)) !== digest
			)
				throw new Error("SOURCE_MISMATCH");
			signal.throwIfAborted();
			this.publish({ source: { digest, packageText: value.packageText } });
		});
	execute = (command: PackCommand) => {
		if (
			!this.inScope(command.params) ||
			this.state.pending ||
			this.state.incompatible ||
			!this.state.loaded ||
			this.state.failed ||
			(this.archived && (command.method === "bindToolPack" || command.method === "authorizeRetainedToolPack"))
		)
			return Promise.resolve();
		const captured = structuredClone(command);
		return this.run(async (signal) => {
			const pending = await pendingCommand(captured);
			signal.throwIfAborted();
			if (this.archived && (captured.method === "bindToolPack" || captured.method === "authorizeRetainedToolPack"))
				return;
			savePackCommand(this.local, this.key, pending);
			this.publish({ pending, notFound: false });
			await this.send(captured, signal);
		});
	};
	/** A missing receipt only enables a user-requested retry with the original immutable command. */
	retry = (packageText?: string) => {
		const pending = this.state.pending;
		if (!pending || !this.state.notFound || this.state.incompatible || this.archived) return Promise.resolve();
		return this.run(async (signal) => {
			let command: PackCommand;
			if (pending.install) {
				if (packageText === undefined) throw new Error("REIMPORT_REQUIRED");
				validatePackageText(packageText);
				if ((await sha256(packageText)) !== pending.install.expectedDigest) throw new Error("SOURCE_MISMATCH");
				command = { version: PROTOCOL_VERSION, method: "installToolPack", params: { ...pending.install, packageText } };
			} else if (pending.command) command = pending.command;
			else throw new Error("INVALID_RECOVERY");
			if ((await sha256(toolPackCommandPayload(command.method, command.params))) !== pending.lookup.requestDigest)
				throw new Error("COMMAND_MISMATCH");
			signal.throwIfAborted();
			// Recheck immediately before retry; a late committed receipt must prevent another send.
			await this.lookup(signal);
			if (this.state.pending && !this.archived) await this.send(command, signal);
			else await this.read(signal);
		});
	};
	private async send(command: PackCommand, signal: AbortSignal) {
		try {
			switch (command.method) {
				case "installToolPack":
					await this.client.call(command.method, command.params, signal);
					break;
				case "setToolPackEnabled":
					await this.client.call(command.method, command.params, signal);
					break;
				case "uninstallToolPack":
					await this.client.call(command.method, command.params, signal);
					break;
				case "bindToolPack":
					await this.client.call(command.method, command.params, signal);
					break;
				case "revokeToolPackBinding":
					await this.client.call(command.method, command.params, signal);
					break;
				case "authorizeRetainedToolPack":
					await this.client.call(command.method, command.params, signal);
					break;
			}
		} catch {
			signal.throwIfAborted();
		}
		signal.throwIfAborted();
		await this.lookup(signal);
		await this.read(signal);
	}
	cancel = () => {
		this.request?.abort();
	};
	activate = () => {
		this.disposed = false;
	};
	dispose = () => {
		this.disposed = true;
		this.request?.abort();
		this.request = null;
		this.listeners.clear();
	};
}
export function bindingCapacity(bindings: ToolPackBinding[], now: number) {
	const active = bindings.filter((binding) => binding.status === "active" && binding.expiresAt > now);
	return {
		live: active.filter((binding) => binding.purpose === "live-package").length < 4 && active.length < 32,
		retained: active.length < 32,
	};
}
export function bindingRequest(scope: Scope, model: Params<"bindToolPack">["model"], duration: number) {
	return {
		...scope,
		requestId: crypto.randomUUID(),
		model: { ...model },
		expiresAt: Date.now() + duration,
		disclosureVersion: 1 as const,
	};
}
