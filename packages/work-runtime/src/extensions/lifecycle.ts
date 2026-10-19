import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	type ConversationRecord,
	defineExtension,
	defineTool,
	type Extension,
	type Registry,
	type Tx,
} from "@earendil-works/pi-durable";
import type { AgentToolBroker, ExtensionAuthorizationPort } from "../agent-tools.ts";
import { AppError, type ModelReference } from "../contracts.ts";
import { assertConversationActive } from "../conversation-directory.ts";
import {
	parseToolPackResult,
	type ToolPackBinding,
	type ToolPackMethods,
	type ToolPackMutationMethod,
	type ToolPackMutations,
	type ToolPackPreview,
	type ToolPackRecord,
	toolPackCommandPayload,
} from "./contracts.ts";
import { descriptorDigest, type PackageDescriptor, packDescriptor } from "./lifecycle-descriptors.ts";
import {
	PackAuditDoc,
	PackBindingDoc,
	PackCommandDoc,
	PackConversationDoc,
	PackDoc,
	PackHeaderDoc,
	PackIdentityDoc,
	packCommandKey,
	packIdentityKey,
} from "./lifecycle-store.ts";
import { executeToolPack, type ParsedToolPack, parseToolPack, ToolPackError } from "./pack.ts";

type Input<M extends keyof ToolPackMethods> = ToolPackMethods[M]["params"];
const sameModel = (a: ModelReference, b: ModelReference) => a.provider === b.provider && a.modelId === b.modelId;
const extensionName = (digest: string) => `hipi.pack.${digest}.v1`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function parsedText(text: string): ParsedToolPack {
	if (/[\ud800-\udfff]/u.test(text)) throw new AppError("INVALID_REQUEST");
	try {
		return parseToolPack(Buffer.from(text, "utf8"));
	} catch (error) {
		if (error instanceof ToolPackError)
			throw new AppError(error.code === "PACK_TOO_LARGE" ? "CAPACITY_EXCEEDED" : "INVALID_REQUEST");
		throw error;
	}
}
export function previewToolPack(packageText: string): ToolPackPreview {
	const pack = parsedText(packageText);
	return {
		digest: pack.digest,
		packageId: pack.manifest.id,
		version: pack.manifest.version,
		name: pack.manifest.name,
		description: pack.manifest.description,
		toolCount: pack.manifest.tools.length,
		tools: pack.manifest.tools.map((tool) => ({
			id: tool.id,
			name: tool.name,
			description: tool.description,
			stepCount: tool.pipeline.length,
		})),
	};
}

/** Workspace mutation -> sorted broker conversation locks -> PI commit. Effects never invert that order. */
export class ToolPackLifecycle implements ExtensionAuthorizationPort {
	readonly #workspaceId: string;
	readonly #broker: AgentToolBroker;
	readonly #registry: Registry;
	readonly #core: Extension | undefined;
	readonly #idle: (tx: Tx, id: ConversationId, publicId: string) => Promise<void>;
	readonly #installed = new Map<string, { pack: ParsedToolPack; extension: Extension }>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	#mutation: Promise<unknown> = Promise.resolve();
	#closed = false;
	constructor(
		workspaceId: string,
		broker: AgentToolBroker,
		registry: Registry,
		idle: (tx: Tx, id: ConversationId, publicId: string) => Promise<void>,
	) {
		this.#workspaceId = workspaceId;
		this.#broker = broker;
		this.#registry = registry;
		this.#core = registry.snapshot().extension("hipi.files");
		this.#idle = idle;
	}
	#serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.#mutation.then(() => {
			if (this.#closed) throw new AppError("CLOSED");
			return action();
		});
		this.#mutation = result.catch(() => undefined);
		return result;
	}
	async #locks<T>(ids: readonly number[], action: () => Promise<T>): Promise<T> {
		const ordered = [...new Set(ids)].sort((a, b) => a - b);
		const next = (index: number): Promise<T> =>
			index === ordered.length ? action() : this.#broker.locked(ordered[index], () => next(index + 1));
		return next(0);
	}
	async conversationCreated(tx: Tx, record: ConversationRecord): Promise<void> {
		const state = await tx.doc(PackConversationDoc, String(record.id), null);
		if (record.parent)
			state.dependencies = [
				...(await tx.doc(PackConversationDoc, String(record.parent.conversationId), null)).dependencies,
			];
		// Child tasks and forks inherit history dependencies, never the parent's tool grants.
		(await tx.doc(AgentDoc, record.id)).extensions = ["hipi.files"];
	}
	async register(tx: Tx, id: ConversationId, publicId: string): Promise<void> {
		const state = await tx.doc(PackConversationDoc, String(id), null);
		if (state.publicId && state.publicId !== publicId) throw new AppError("UNAUTHORIZED");
		state.publicId = publicId;
	}
	async #active(tx: Tx, id: ConversationId): Promise<ToolPackBinding[]> {
		const state = await tx.doc(PackConversationDoc, String(id), null);
		if (state.active.length > 32) throw new AppError("CAPACITY_EXCEEDED");
		const values: ToolPackBinding[] = [];
		for (const key of state.active) {
			const doc = await tx.doc(PackBindingDoc, key, null);
			if (
				!doc.value ||
				doc.conversationId !== id ||
				doc.value.workspaceId !== this.#workspaceId ||
				doc.value.conversationId !== state.publicId
			)
				throw new AppError("UNAUTHORIZED");
			if (doc.value.status === "active" && doc.value.expiresAt <= Date.now()) {
				doc.value.status = "expired";
				doc.value.revision++;
				await this.#broker.invalidateInTransaction(tx, id);
			}
			if (doc.value.status === "active") values.push(doc.value);
		}
		state.active = values.map((value) => value.bindingId);
		(await tx.doc(AgentDoc, id)).extensions = [
			"hipi.files",
			...values.filter((value) => value.purpose === "live-package").map((value) => extensionName(value.digest)),
		];
		const head = await tx.doc(PackHeaderDoc);
		if (values.length && !head.live.includes(id)) {
			if (head.live.length >= 256) throw new AppError("CAPACITY_EXCEEDED");
			head.live.push(id);
		} else if (!values.length) head.live = head.live.filter((value) => value !== id);
		return values;
	}
	async #pack(tx: Tx, digest: string): Promise<{ record: ToolPackRecord; pack: ParsedToolPack }> {
		const doc = await tx.doc(PackDoc, digest, null);
		if (
			!doc.value ||
			doc.value.workspaceId !== this.#workspaceId ||
			doc.value.digest !== digest ||
			doc.interpreterVersion !== 1 ||
			doc.packageText === undefined
		)
			throw new AppError("UNAUTHORIZED");
		const pack = parsedText(doc.packageText);
		if (
			pack.digest !== digest ||
			pack.manifest.id !== doc.value.packageId ||
			pack.manifest.version !== doc.value.version ||
			pack.manifest.name !== doc.value.name ||
			pack.manifest.description !== doc.value.description ||
			pack.manifest.tools.length !== doc.value.toolCount
		)
			throw new AppError("UNAUTHORIZED");
		return { record: doc.value, pack };
	}
	#installDefinition(pack: ParsedToolPack): void {
		if (this.#installed.has(pack.digest)) return;
		if (this.#installed.size >= 32) throw new AppError("CAPACITY_EXCEEDED");
		for (const digest of this.#installed.keys())
			if (digest.slice(0, 32) === pack.digest.slice(0, 32)) throw new AppError("IDEMPOTENCY_CONFLICT");
		const tools = pack.manifest.tools.map((tool) => {
			const descriptor = packDescriptor(pack, tool);
			for (const current of this.#registry.snapshot().tools())
				if (current.tool.name === descriptor.name) throw new AppError("IDEMPOTENCY_CONFLICT");
			return defineTool({
				...descriptor,
				callers: ["model"],
				replay: "safe",
				outputLimits: { maxBytes: 65536 },
				execute: async (args, api, execution) => {
					const check = () =>
						this.#broker.harness.commit(async (tx) => {
							const agent = await tx.doc(AgentDoc, api.conversationId);
							if (!agent.model) throw new AppError("UNAUTHORIZED");
							const model = { provider: agent.model.provider, modelId: agent.model.modelId };
							await this.assertContext(tx, api.conversationId, model, "tool");
							const values = await this.#active(tx, api.conversationId);
							if (
								!values.some(
									(value) =>
										value.purpose === "live-package" &&
										value.digest === pack.digest &&
										sameModel(value.model, model),
								)
							)
								throw new AppError("UNAUTHORIZED");
						}, context);
					await this.#broker.locked(api.conversationId, check);
					if (typeof args.rootId !== "string" || typeof args.path !== "string")
						throw new AppError("INVALID_REQUEST");
					const read = await this.#broker.read(api, { rootId: args.rootId, path: args.path });
					if (read.nextOffset !== null) throw new AppError("CAPACITY_EXCEEDED");
					const text = executeToolPack(pack, tool.id, read.text, { signal: execution.abortSignal });
					await this.#broker.locked(api.conversationId, check);
					return { output: [{ type: "text", text: JSON.stringify({ text, revision: read.revision }) }] };
				},
			});
		});
		const extension = defineExtension({ name: extensionName(pack.digest), tools });
		this.#registry.install(extension);
		this.#installed.set(pack.digest, { pack, extension });
	}
	async recover(): Promise<void> {
		const head = await this.#broker.harness.snapshot(PackHeaderDoc, context);
		for (const digest of head?.enabled ?? []) {
			try {
				const pack = await this.#broker.harness.commit(async (tx) => (await this.#pack(tx, digest)).pack, context);
				this.#installDefinition(pack);
			} catch {
				/* Missing/corrupt definitions block dispatch, never cancellation or read-only diagnosis. */
			}
		}
		for (const id of head?.live ?? [])
			await this.#broker.harness.commit(async (tx) => {
				for (const binding of await this.#active(tx, id as ConversationId)) {
					binding.status = "invalidated";
					binding.revision++;
				}
				await this.#active(tx, id as ConversationId);
			}, context);
	}
	async assertContext(
		tx: Tx,
		id: ConversationId,
		model: ModelReference,
		purpose: "admission" | "dispatch" | "tool",
		descriptors?: readonly PackageDescriptor[],
	): Promise<number> {
		if (!this.#core || this.#registry.snapshot().extension("hipi.files") !== this.#core)
			throw new AppError("UNAUTHORIZED");
		const state = await tx.doc(PackConversationDoc, String(id), null);
		const values = await this.#active(tx, id);
		let expiry = Number.MAX_SAFE_INTEGER;
		const permitted = (digest: string, live: boolean) => {
			const value = values.find(
				(value) =>
					value.digest === digest && sameModel(value.model, model) && (!live || value.purpose === "live-package"),
			);
			if (!value) throw new AppError("UNAUTHORIZED");
			expiry = Math.min(expiry, value.expiresAt);
			return value;
		};
		for (const binding of values.filter((value) => value.purpose === "live-package")) {
			const pack = await this.#pack(tx, binding.digest);
			const installed = this.#installed.get(binding.digest);
			if (
				pack.record.status !== "enabled" ||
				!installed ||
				this.#registry.snapshot().extension(extensionName(binding.digest)) !== installed.extension ||
				!sameModel(binding.model, model)
			)
				throw new AppError("UNAUTHORIZED");
			expiry = Math.min(expiry, binding.expiresAt);
		}
		for (const digest of state.dependencies) permitted(digest, false);
		if ((descriptors?.length ?? 0) > 2048) throw new AppError("CAPACITY_EXCEEDED");
		for (const descriptor of descriptors ?? []) {
			const match = /^pack_([a-f0-9]{32})_([a-z][a-z0-9_]{0,23})$/.exec(descriptor.name);
			if (!match) throw new AppError("UNAUTHORIZED");
			const candidates = values.filter(
				(binding) => binding.digest.startsWith(match[1]) && sameModel(binding.model, model),
			);
			const digests = [...new Set(candidates.map((binding) => binding.digest))];
			if (digests.length !== 1) throw new AppError("UNAUTHORIZED");
			const digest = digests[0];
			const grant = permitted(digest, descriptor.active);
			const { pack } = await this.#pack(tx, digest);
			const tool = pack.manifest.tools.find((tool) => tool.id === match[2]);
			if (!tool || descriptorDigest(packDescriptor(pack, tool)) !== descriptor.digest)
				throw new AppError("UNAUTHORIZED");
			if (purpose === "dispatch") {
				if (!state.dependencies.includes(digest)) {
					if (state.dependencies.length >= 256) throw new AppError("CAPACITY_EXCEEDED");
					state.dependencies.push(digest);
				}
				if (!grant.disclosed) {
					grant.disclosed = true;
					grant.revision++;
				}
			}
		}
		if (expiry <= Date.now()) throw new AppError("UNAUTHORIZED");
		return expiry;
	}
	async #command<M extends ToolPackMutationMethod>(
		tx: Tx,
		method: M,
		input: ToolPackMutations[M]["params"],
		action: () => Promise<ToolPackMutations[M]["result"]>,
	): Promise<ToolPackMutations[M]["result"]> {
		if (input.workspaceId !== this.#workspaceId) throw new AppError("NOT_FOUND");
		const requestDigest = createHash("sha256").update(toolPackCommandPayload(method, input)).digest("hex");
		const command = await tx.doc(PackCommandDoc, packCommandKey(input.workspaceId, input.requestId), null);
		if (command.value) {
			if (command.value.method !== method || command.value.requestDigest !== requestDigest)
				throw new AppError("IDEMPOTENCY_CONFLICT");
			const current =
				"bindingId" in command.value.result
					? (await tx.doc(PackBindingDoc, command.value.result.bindingId, null)).value
					: (await tx.doc(PackDoc, command.value.result.digest, null)).value;
			if (!current) throw new AppError("INTERNAL");
			return clone(parseToolPackResult(method, current));
		}
		const result = await action();
		const scope =
			"conversationId" in input
				? { workspaceId: input.workspaceId, conversationId: input.conversationId }
				: { workspaceId: input.workspaceId };
		const envelope = parseToolPackResult("getToolPackCommandResult", { method, scope, requestDigest, result });
		if (!envelope) throw new AppError("INTERNAL");
		command.value = envelope;
		command.resultId = "bindingId" in result ? result.bindingId : result.digest;
		return clone(result);
	}
	install(input: Input<"installToolPack">): Promise<ToolPackRecord> {
		return this.#serialize(() =>
			this.#broker.harness.commit(
				(tx) =>
					this.#command(tx, "installToolPack", input, async () => {
						const pack = parsedText(input.packageText);
						if (pack.digest !== input.expectedDigest || input.disclosureVersion !== 1)
							throw new AppError("INVALID_REQUEST");
						const identity = await tx.doc(
							PackIdentityDoc,
							packIdentityKey(pack.manifest.id, pack.manifest.version),
							null,
						);
						if (identity.digest && identity.digest !== pack.digest) throw new AppError("IDEMPOTENCY_CONFLICT");
						const doc = await tx.doc(PackDoc, pack.digest, null);
						if (doc.value) {
							if (doc.value.status === "uninstalled") {
								doc.value.status = "disabled";
								doc.value.revision++;
							}
							return doc.value;
						}
						const { tools: _tools, ...summary } = previewToolPack(input.packageText);
						doc.value = {
							...summary,
							workspaceId: input.workspaceId,
							formatVersion: 1,
							status: "disabled",
							revision: 1,
							installedAt: Date.now(),
						};
						doc.packageText = input.packageText;
						identity.digest = pack.digest;
						const head = await tx.doc(PackHeaderDoc);
						if (!Number.isSafeInteger(head.count + 1)) throw new AppError("CAPACITY_EXCEEDED");
						(await tx.doc(PackAuditDoc, `packs-${Math.floor(head.count / 64)}`, null)).ids.push(pack.digest);
						head.count++;
						return doc.value;
					}),
				context,
			),
		);
	}
	change(
		method: "setToolPackEnabled" | "uninstallToolPack",
		input: Input<"setToolPackEnabled"> | Input<"uninstallToolPack">,
	): Promise<ToolPackRecord> {
		return this.#serialize(async () => {
			const head = await this.#broker.harness.snapshot(PackHeaderDoc, context);
			const ids: number[] = [];
			for (const id of head?.live ?? []) {
				const state = await this.#broker.harness.snapshot(PackConversationDoc, String(id), context);
				for (const key of state?.active ?? []) {
					const binding = (await this.#broker.harness.snapshot(PackBindingDoc, key, context))?.value;
					if (binding?.purpose === "live-package" && binding.digest === input.digest) {
						ids.push(id);
						break;
					}
				}
			}
			const stops: (() => Promise<void>)[] = [];
			const invalidatedBindings: string[] = [];
			const result = await this.#locks(ids, async () => {
				for (const id of ids) stops.push(await this.#broker.captureStop(id as ConversationId));
				const result = await this.#broker.harness.commit(
					(tx) =>
						this.#command(tx, method, input, async () => {
							const doc = await tx.doc(PackDoc, input.digest, null);
							if (!doc.value || doc.value.workspaceId !== this.#workspaceId) throw new AppError("NOT_FOUND");
							if (doc.value.revision !== input.expectedRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
							const enabled = method === "setToolPackEnabled" && "enabled" in input && input.enabled;
							const header = await tx.doc(PackHeaderDoc);
							if (enabled) {
								if (doc.value.status === "uninstalled") throw new AppError("UNAUTHORIZED");
								if (!header.enabled.includes(input.digest) && header.enabled.length >= 32)
									throw new AppError("CAPACITY_EXCEEDED");
								this.#installDefinition((await this.#pack(tx, input.digest)).pack);
								if (!header.enabled.includes(input.digest)) header.enabled.push(input.digest);
							} else {
								header.enabled = header.enabled.filter((digest) => digest !== input.digest);
								for (const id of ids) {
									for (const binding of await this.#active(tx, id as ConversationId))
										if (binding.digest === input.digest && binding.purpose === "live-package") {
											binding.status = "invalidated";
											binding.revision++;
											invalidatedBindings.push(binding.bindingId);
										}
									await this.#active(tx, id as ConversationId);
									await this.#broker.invalidateInTransaction(tx, id as ConversationId);
								}
							}
							doc.value.status = enabled
								? "enabled"
								: method === "uninstallToolPack"
									? "uninstalled"
									: "disabled";
							doc.value.revision++;
							return doc.value;
						}),
					context,
				);
				if (result.status !== "enabled") {
					this.clearTimers(invalidatedBindings);
					for (const id of ids) this.#broker.interruptLocked(id as ConversationId);
					const installed = this.#installed.get(input.digest);
					if (installed) this.#registry.uninstall(installed.extension);
					this.#installed.delete(input.digest);
				}
				return result;
			});
			if (result.status !== "enabled") for (const stop of stops) await stop();
			return result;
		});
	}
	bind(
		id: ConversationId,
		input: Input<"bindToolPack"> | Input<"authorizeRetainedToolPack">,
	): Promise<ToolPackBinding> {
		return this.#serialize(async () => {
			const result = await this.#broker.locked(id, () =>
				this.#broker.harness.commit(
					(tx) =>
						this.#command(
							tx,
							"sourceBindingId" in input ? "authorizeRetainedToolPack" : "bindToolPack",
							input,
							async () => {
								await assertConversationActive(tx, input.conversationId);
								await this.#idle(tx, id, input.conversationId);
								await this.register(tx, id, input.conversationId);
								const state = await tx.doc(PackConversationDoc, String(id), null);
								if (state.publicId !== input.conversationId) throw new AppError("UNAUTHORIZED");
								const agent = await tx.doc(AgentDoc, id);
								if (!agent.model || !sameModel(agent.model, input.model)) throw new AppError("UNAUTHORIZED");
								if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 86400000)
									throw new AppError("INVALID_REQUEST");
								const active = await this.#active(tx, id);
								if (active.length >= 32) throw new AppError("CAPACITY_EXCEEDED");
								let digest: string;
								if ("sourceBindingId" in input) {
									const source = await tx.doc(PackBindingDoc, input.sourceBindingId, null);
									if (
										!source.value ||
										source.conversationId !== id ||
										source.value.purpose !== "live-package" ||
										!source.value.disclosed
									)
										throw new AppError("UNAUTHORIZED");
									digest = source.value.digest;
									await this.#pack(tx, digest);
								} else {
									digest = input.digest;
									const pack = await this.#pack(tx, digest);
									if (pack.record.status !== "enabled" || pack.record.revision !== input.expectedPackRevision)
										throw new AppError("IDEMPOTENCY_CONFLICT");
									if (active.filter((value) => value.purpose === "live-package").length >= 4)
										throw new AppError("CAPACITY_EXCEEDED");
									if (active.some((value) => value.purpose === "live-package" && value.digest === digest))
										throw new AppError("IDEMPOTENCY_CONFLICT");
									this.#installDefinition(pack.pack);
								}
								const value: ToolPackBinding = {
									workspaceId: input.workspaceId,
									conversationId: input.conversationId,
									bindingId: randomUUID(),
									digest,
									model: clone(input.model),
									expiresAt: input.expiresAt,
									disclosureVersion: 1,
									disclosed: false,
									revision: 1,
									createdAt: Date.now(),
									status: "active",
									...("sourceBindingId" in input
										? { purpose: "retained-package", sourceBindingId: input.sourceBindingId }
										: { purpose: "live-package" }),
								};
								const doc = await tx.doc(PackBindingDoc, value.bindingId, null);
								doc.conversationId = id;
								doc.value = value;
								state.active.push(value.bindingId);
								(await tx.doc(PackAuditDoc, `bindings-${id}-${Math.floor(state.count / 64)}`, null)).ids.push(
									value.bindingId,
								);
								state.count++;
								await this.#active(tx, id);
								return value;
							},
						),
					context,
				),
			);
			this.#arm(id, result);
			return result;
		});
	}
	revoke(id: ConversationId, input: Input<"revokeToolPackBinding">): Promise<ToolPackBinding> {
		return this.#serialize(async () => {
			let invalidated = false;
			let stop: (() => Promise<void>) | undefined;
			const result = await this.#broker.locked(id, async () => {
				stop = await this.#broker.captureStop(id);
				const value = await this.#broker.harness.commit(
					(tx) =>
						this.#command(tx, "revokeToolPackBinding", input, async () => {
							const doc = await tx.doc(PackBindingDoc, input.bindingId, null);
							if (!doc.value || doc.conversationId !== id || doc.value.conversationId !== input.conversationId)
								throw new AppError("NOT_FOUND");
							if (doc.value.revision !== input.expectedRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
							invalidated = doc.value.status === "active";
							doc.value.status = "revoked";
							doc.value.revision++;
							await this.#active(tx, id);
							if (invalidated) await this.#broker.invalidateInTransaction(tx, id);
							return doc.value;
						}),
					context,
				);
				if (invalidated) this.#broker.interruptLocked(id);
				clearTimeout(this.#timers.get(input.bindingId));
				this.#timers.delete(input.bindingId);
				return value;
			});
			if (invalidated) await stop?.();
			return result;
		});
	}
	#arm(id: ConversationId, binding: ToolPackBinding): void {
		if (binding.status !== "active" || this.#timers.has(binding.bindingId)) return;
		const timer = setTimeout(
			() => {
				this.#timers.delete(binding.bindingId);
				void this.#serialize(async () => {
					const value = (await this.#broker.harness.snapshot(PackBindingDoc, binding.bindingId, context))?.value;
					if (!value || value.status !== "active") return;
					if (value.expiresAt > Date.now()) {
						this.#arm(id, value);
						return;
					}
					let stop: (() => Promise<void>) | undefined;
					await this.#broker.locked(id, async () => {
						stop = await this.#broker.captureStop(id);
						await this.#broker.harness.commit(async (tx) => {
							await this.#active(tx, id);
							await this.#broker.invalidateInTransaction(tx, id);
						}, context);
						this.#broker.interruptLocked(id);
					});
					await stop?.();
				}).catch(() => undefined);
			},
			Math.max(1, binding.expiresAt - Date.now()),
		);
		timer.unref();
		this.#timers.set(binding.bindingId, timer);
	}
	async archive(tx: Tx, id: ConversationId): Promise<string[]> {
		const values = await this.#active(tx, id);
		for (const value of values) {
			value.status = "invalidated";
			value.revision++;
		}
		await this.#active(tx, id);
		return values.map((value) => value.bindingId);
	}
	/** Called only after the invalidation transaction commits. Historical grants never retain timers. */
	clearTimers(ids: readonly string[]): void {
		for (const id of ids) {
			clearTimeout(this.#timers.get(id));
			this.#timers.delete(id);
		}
	}
	async hasLive(): Promise<boolean> {
		return ((await this.#broker.harness.snapshot(PackHeaderDoc, context))?.live.length ?? 0) > 0;
	}
	close(): void {
		this.#closed = true;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}
