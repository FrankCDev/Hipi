import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	type ConversationRecord,
	createRegistry,
	defineExtension,
	defineTool,
	type Harness,
	hook,
	LiveDoc,
	ProviderDoc,
	section,
	type TaskId,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";
import { filePresentationDetails } from "./activities/file-presentation.ts";
import {
	ApprovalDoc,
	type AuthorizationState,
	appendAudit,
	auditCursor,
	auditId,
	auditPosition,
	BindingDoc,
	bindingKey,
	CommandDoc,
	ContextDoc,
	commandKey,
	type DefaultProjectAccess,
	DefaultProjectDoc,
	type Dependency,
	GrantDoc,
	LegacyContextDoc,
	OperationDoc,
	resolveAgentCommandResult,
} from "./agent-tools/authorization-store.ts";
import type { ModelDispatchAuthorization } from "./agent-tools/model-gate.ts";
import {
	type AgentContext,
	type AgentContextRequest,
	AppError,
	type FileOperation,
	fitsPayloadBudget,
	type ModelReference,
	type Params,
	parseToolApproval,
	type Result,
	type RetainedContextRequest,
	type Scope,
	type ToolApproval,
} from "./contracts.ts";
import type { PackageDescriptor } from "./extensions/lifecycle-descriptors.ts";
import { FileServiceError, validateRelativePath } from "./files/contracts.ts";
import type { TrustedAgentFileService, TrustedProjectContext } from "./files/service.ts";

export interface ExtensionAuthorizationPort {
	register(tx: Tx, id: ConversationId, publicId: string): Promise<void>;
	assertContext(
		tx: Tx,
		id: ConversationId,
		model: ModelReference,
		purpose: "admission" | "dispatch" | "tool",
		descriptors?: readonly PackageDescriptor[],
	): Promise<number>;
}

export type AgentAuthorizationHooks = {
	auditGeneration(tx: Tx): Promise<string>;
	assertConversationActive(tx: Tx, publicId: string): Promise<void>;
	updateBrokerLive(tx: Tx, publicId: string, hasLive: boolean): Promise<void>;
};
type Call = { conversationId: ConversationId; taskId: TaskId; callId: string };
type ReadArgs = { rootId: string; path: string };
type SaveArgs = ReadArgs & { text: string; ifMatch: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const argsHash = (args: SaveArgs) =>
	hash(JSON.stringify([1, "hipi_files_save", args.rootId, args.path, args.ifMatch, args.text]));
const sameModel = (a: ModelReference, b: ModelReference) => a.provider === b.provider && a.modelId === b.modelId;
const covers = (prefix: string, path: string) => prefix === "" || prefix === path || path.startsWith(`${prefix}/`);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ROOT_METADATA_BYTES = 8192;
// Default access may become available after grant admission. Reserve its largest host-validated descriptor.
const PROJECT_METADATA_RESERVE = Buffer.byteLength(JSON.stringify({ rootId: "x".repeat(128), pathPrefixes: [""] })) + 1;

/** One workspace-owned broker. Durable documents are authority; locks only order final local effects. */
export class AgentToolBroker implements ModelDispatchAuthorization {
	#harness: Harness | undefined;
	readonly #workspaceId: string;
	readonly #files: (() => TrustedAgentFileService | undefined) | undefined;
	readonly #locks = new Map<number, Promise<unknown>>();
	readonly #inflight = new Map<number, Map<AbortController, ModelReference>>();
	readonly #expiry = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #closed = new AbortController();
	readonly #hooks: AgentAuthorizationHooks | undefined;
	#extensions: ExtensionAuthorizationPort | undefined;
	readonly #receipts: (tx: Tx, ids: string[], publicId: string) => Promise<string[]>;
	constructor(
		workspaceId: string,
		files: (() => TrustedAgentFileService | undefined) | undefined,
		receipts: (tx: Tx, ids: string[], publicId: string) => Promise<string[]>,
		hooks?: AgentAuthorizationHooks,
	) {
		this.#workspaceId = workspaceId;
		this.#files = files;
		this.#receipts = receipts;
		this.#hooks = hooks;
	}
	attach(harness: Harness) {
		this.#harness = harness;
	}
	attachExtensions(port: ExtensionAuthorizationPort): void {
		this.#extensions = port;
	}
	/** Caller holds this broker's conversation lock. Never reacquire it here. */
	interruptLocked(id: ConversationId): void {
		for (const controller of this.#inflight.get(id)?.keys() ?? []) controller.abort(new AppError("UNAUTHORIZED"));
	}
	/** Capture before a lifecycle mutation; its asynchronous tail must never inspect and cancel newer work. */
	async captureStop(id: ConversationId): Promise<() => Promise<void>> {
		const inspection = await this.harness.inspect(background);
		const tasks = inspection.tasks
			.filter(({ record }) => record.conversationId === id)
			.map(({ record }) => record.id);
		const submissions = inspection.submissions
			.filter((record) => record.conversationId === id && record.status === "queued")
			.map((record) => record.id);
		return async () => {
			for (const task of tasks) await this.harness.abortTask(task, background);
			for (const submission of submissions) await this.harness.abortSubmission(submission, background, id);
		};
	}
	get harness(): Harness {
		if (!this.#harness || this.#closed.signal.aborted) throw new AppError("CLOSED");
		return this.#harness;
	}
	files(): TrustedAgentFileService {
		const files = this.#files?.();
		if (!files) throw new AppError("UNAUTHORIZED");
		return files;
	}
	async locked<T>(id: number, action: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(id) ?? Promise.resolve();
		const result = previous.then(action);
		const tail = result.catch(() => undefined);
		this.#locks.set(id, tail);
		try {
			return await result;
		} finally {
			if (this.#locks.get(id) === tail) this.#locks.delete(id);
		}
	}
	async #live(tx: Tx, state: AuthorizationState): Promise<void> {
		await this.#hooks?.updateBrokerLive(
			tx,
			state.publicId,
			state.grantIds.length > 0 || state.pendingIds.length > 0 || state.operationIds.length > 0,
		);
	}
	async #active(tx: Tx, state: AuthorizationState): Promise<void> {
		if (!state.publicId) throw new AppError("UNAUTHORIZED");
		await this.#hooks?.assertConversationActive(tx, state.publicId);
	}
	async #grants(tx: Tx, id: ConversationId, state: AuthorizationState): Promise<AgentContext[]> {
		const result: AgentContext[] = [];
		for (const key of state.grantIds) {
			const record = await tx.doc(GrantDoc, key, null);
			if (
				!record.value ||
				record.conversationId !== id ||
				record.value.conversationId !== state.publicId ||
				record.value.workspaceId !== this.#workspaceId
			)
				throw new AppError("UNAUTHORIZED");
			if (record.value.status === "active" && record.value.expiresAt <= Date.now()) {
				record.value.status = "expired";
				record.value.revision++;
			}
			if (record.value.status === "active") result.push(record.value);
		}
		state.grantIds = result.map((value) => value.grantId);
		await this.#live(tx, state);
		return result;
	}
	async #storedGrant(tx: Tx, id: ConversationId, state: AuthorizationState, key: string): Promise<AgentContext> {
		const record = await tx.doc(GrantDoc, key, null);
		if (
			!record.value ||
			record.conversationId !== id ||
			record.value.conversationId !== state.publicId ||
			record.value.workspaceId !== this.#workspaceId
		)
			throw new AppError("NOT_FOUND");
		return record.value;
	}
	async #command(tx: Tx, id: ConversationId, state: AuthorizationState, requestId: string) {
		const record = await tx.doc(CommandDoc, commandKey(id, requestId), null);
		if (
			record.value &&
			(record.conversationId !== id || record.publicId !== state.publicId || record.value.requestId !== requestId)
		)
			throw new AppError("UNAUTHORIZED");
		return record;
	}
	async conversationCreated(tx: Tx, record: ConversationRecord): Promise<void> {
		const provider = await tx.doc(ProviderDoc, record.id);
		const state = await tx.doc(ContextDoc, String(record.id), null);
		const binding = await tx.doc(BindingDoc, bindingKey(provider.sessionId), null);
		if (
			(state.sessionId && state.sessionId !== provider.sessionId) ||
			(binding.sessionId && (binding.sessionId !== provider.sessionId || binding.conversationId !== record.id))
		)
			throw new AppError("UNAUTHORIZED");
		state.sessionId = provider.sessionId;
		binding.sessionId = provider.sessionId;
		binding.conversationId = record.id;
		if (record.parent) {
			const source = await tx.doc(ContextDoc, String(record.parent.conversationId), null);
			state.dependencies = copy(source.dependencies);
		}
	}
	async register(tx: Tx, id: ConversationId, publicId: string): Promise<void> {
		await this.conversationCreated(tx, { id });
		const state = await tx.doc(ContextDoc, String(id), null);
		if (state.publicId && state.publicId !== publicId) throw new AppError("UNAUTHORIZED");
		state.publicId = publicId;
	}
	async migrateConversation(tx: Tx, id: ConversationId, publicId: string): Promise<void> {
		await this.register(tx, id, publicId);
		const state = await tx.doc(ContextDoc, String(id), null);
		if (state.initialized) return;
		if (state.grantCount || state.approvalCount || state.operationCount) {
			state.initialized = true;
			return;
		}
		const legacy = await tx.doc(LegacyContextDoc, String(id), null);
		if (
			legacy.grants.length > 32 ||
			legacy.commands.length > 256 ||
			legacy.approvals.length > 64 ||
			legacy.dependencies.length > 256
		)
			throw new AppError("CAPACITY_EXCEEDED");
		if (legacy.publicId && legacy.publicId !== publicId) throw new AppError("UNAUTHORIZED");
		state.dependencies = copy(legacy.dependencies);
		state.cancelled = legacy.cancelled;
		for (const original of legacy.grants) {
			const grant = copy(original);
			if (grant.workspaceId !== this.#workspaceId || grant.conversationId !== publicId)
				throw new AppError("UNAUTHORIZED");
			if (!("purpose" in grant)) Object.assign(grant, { purpose: "live-files" });
			const target = await tx.doc(GrantDoc, grant.grantId, null);
			if (target.value) throw new AppError("INTERNAL");
			target.conversationId = id;
			target.value = grant;
			if (grant.status === "active") state.grantIds.push(grant.grantId);
			await appendAudit(tx, id, state, "grant", grant.grantId);
		}
		for (const command of legacy.commands) {
			const target = await this.#command(tx, id, state, command.requestId);
			if (target.value) throw new AppError("INTERNAL");
			target.conversationId = id;
			target.publicId = publicId;
			target.value = copy(command);
		}
		for (const key of legacy.approvals) {
			const approval = (await tx.doc(ApprovalDoc, key, null)).value;
			if (!approval || approval.conversationId !== publicId || approval.workspaceId !== this.#workspaceId)
				throw new AppError("UNAUTHORIZED");
			await appendAudit(tx, id, state, "approval", key);
			if (approval.status === "pending" || approval.status === "approved") state.pendingIds.push(key);
			if (approval.operationId) {
				const operation = (await tx.doc(OperationDoc, approval.operationId, null)).value;
				if (!operation || operation.conversationId !== publicId || operation.workspaceId !== this.#workspaceId)
					throw new AppError("UNAUTHORIZED");
				await appendAudit(tx, id, state, "operation", approval.operationId);
				if (["prepared", "executing", "unknown", "observed_match"].includes(operation.status))
					state.operationIds.push(approval.operationId);
			}
		}
		state.initialized = true;
		await this.#live(tx, state);
		await tx.retireDoc(LegacyContextDoc, String(id));
	}
	async recover(id: ConversationId): Promise<void> {
		await this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			for (const grant of await this.#grants(tx, id, state)) {
				grant.status = "invalidated";
				grant.revision++;
			}
			state.grantIds = [];
			for (const key of state.pendingIds) {
				const approval = (await tx.doc(ApprovalDoc, key, null)).value;
				if (!approval) throw new AppError("INTERNAL");
				if (approval.status === "pending" || approval.status === "approved") {
					approval.status = "invalidated";
					approval.revision++;
				}
			}
			state.pendingIds = [];
			for (const key of state.operationIds) {
				const operation = (await tx.doc(OperationDoc, key, null)).value;
				if (operation?.status === "executing" || operation?.status === "prepared") {
					operation.status = "unknown";
					operation.revision++;
				}
			}
			await this.#live(tx, state);
		}, background);
	}
	async archiveInTransaction(tx: Tx, id: ConversationId): Promise<void> {
		const state = await tx.doc(ContextDoc, String(id), null);
		if (state.pendingIds.length) throw new AppError("CONVERSATION_BUSY");
		if (state.operationIds.length) throw new AppError("RECONCILIATION_REQUIRED");
		for (const grant of await this.#grants(tx, id, state)) {
			grant.status = "invalidated";
			grant.revision++;
		}
		state.grantIds = [];
		await this.#live(tx, state);
	}
	async #scope(id: ConversationId): Promise<Scope> {
		const state = await this.harness.snapshot(ContextDoc, String(id), background);
		if (!state?.publicId) throw new AppError("UNAUTHORIZED");
		return { workspaceId: this.#workspaceId, conversationId: state.publicId };
	}
	async #root(rootId: string, writable = false): Promise<void> {
		const roots = await this.files().listRoots(this.#workspaceId);
		if (!roots.some((root) => root.rootId === rootId && (!writable || root.writable)))
			throw new AppError("UNAUTHORIZED");
	}
	/** Only the verified host binding can supply a default scope. listRoots is never a substitute. */
	async #currentProject(): Promise<TrustedProjectContext | null> {
		const project = (await this.#files?.()?.currentProject?.(this.#workspaceId)) ?? null;
		if (!project) return null;
		if (
			project.workspaceId !== this.#workspaceId ||
			typeof project.bindingId !== "string" ||
			!/^[-\w]{1,128}$/.test(project.bindingId) ||
			!Number.isSafeInteger(project.bindingRevision) ||
			project.bindingRevision < 1 ||
			!project.root ||
			project.root.workspaceId !== this.#workspaceId ||
			typeof project.root.rootId !== "string" ||
			!/^[-\w]{1,128}$/.test(project.root.rootId) ||
			project.root.writable !== false
		)
			throw new AppError("UNAUTHORIZED");
		const roots = await this.files().listRoots(this.#workspaceId);
		if (
			!roots.some(
				(root) => root.workspaceId === this.#workspaceId && root.rootId === project.root.rootId && !root.writable,
			)
		)
			throw new AppError("UNAUTHORIZED");
		this.files().assertRoot(this.#workspaceId, project.root.rootId);
		return project;
	}
	async #projectPolicy(tx: Tx, id: ConversationId): Promise<DefaultProjectAccess> {
		const policy = await tx.doc(DefaultProjectDoc, String(id), null);
		if (
			!["uninitialized", "default", "restricted"].includes(policy.mode) ||
			(policy.blockedBindingId !== null &&
				(typeof policy.blockedBindingId !== "string" || !/^[-\w]{1,128}$/.test(policy.blockedBindingId))) ||
			Object.keys(policy).some((key) => key !== "mode" && key !== "blockedBindingId")
		)
			throw new AppError("UNAUTHORIZED");
		return policy;
	}
	/** Called only in an actual new conversation's creation transaction, never registration/recovery. */
	async initializeProjectAccess(tx: Tx, id: ConversationId): Promise<void> {
		const policy = await this.#projectPolicy(tx, id);
		if (policy.mode !== "uninitialized") throw new AppError("UNAUTHORIZED");
		policy.mode = "default";
	}
	async #project(
		tx: Tx,
		id: ConversationId,
		state: AuthorizationState,
		current: TrustedProjectContext | null,
		admission = false,
	): Promise<TrustedProjectContext | null> {
		const policy = await this.#projectPolicy(tx, id);
		for (const dependency of state.dependencies) this.#provenance(dependency);
		if (policy.mode === "uninitialized" && admission) {
			// Empty active grants are not evidence of no history: revoked/expired grants remain counted.
			policy.mode = state.dependencies.length === 0 && state.grantCount === 0 ? "default" : "restricted";
		}
		return policy.mode === "default" && current && policy.blockedBindingId !== current.bindingId ? current : null;
	}
	#provenance(dependency: Dependency): Dependency["project"] {
		if (!("project" in dependency)) return undefined;
		const project = dependency.project;
		if (
			!project ||
			typeof project.bindingId !== "string" ||
			!/^[-\w]{1,128}$/.test(project.bindingId) ||
			!Number.isSafeInteger(project.bindingRevision) ||
			project.bindingRevision < 1 ||
			Object.keys(project).some((key) => key !== "bindingId" && key !== "bindingRevision")
		)
			throw new AppError("UNAUTHORIZED");
		return project;
	}
	#dependency(
		state: AuthorizationState,
		grants: AgentContext[],
		dependency: Dependency,
		model: ModelReference,
		project: TrustedProjectContext | null,
		admission = false,
	): { rootId: string | null; expiresAt: number } {
		const provenance = this.#provenance(dependency);
		if (
			project &&
			provenance?.bindingId === project.bindingId &&
			provenance.bindingRevision === project.bindingRevision
		)
			return { rootId: project.root.rootId, expiresAt: Number.MAX_SAFE_INTEGER };
		const grant = this.#grant(state, grants, dependency, model, true, admission);
		return { rootId: grant.purpose === "live-files" ? grant.rootId : null, expiresAt: grant.expiresAt };
	}
	#recordDependency(state: AuthorizationState, args: ReadArgs, project: TrustedProjectContext | null = null): void {
		const found = state.dependencies.some((item) => {
			const provenance = this.#provenance(item);
			return project
				? provenance?.bindingId === project.bindingId &&
						provenance.bindingRevision === project.bindingRevision &&
						covers(item.path, args.path)
				: !provenance && item.rootId === args.rootId && covers(item.path, args.path);
		});
		if (found) return;
		if (state.dependencies.length >= 256) throw new AppError("CAPACITY_EXCEEDED");
		state.dependencies.push({
			rootId: args.rootId,
			path: args.path,
			...(project ? { project: { bindingId: project.bindingId, bindingRevision: project.bindingRevision } } : {}),
		});
	}
	async #model(tx: Tx, id: ConversationId): Promise<ModelReference> {
		const agent = await tx.doc(AgentDoc, id);
		if (!agent.model) throw new AppError("MODEL_UNAVAILABLE");
		return { provider: agent.model.provider, modelId: agent.model.modelId };
	}
	#grant(
		state: AuthorizationState,
		grants: AgentContext[],
		args: ReadArgs,
		model: ModelReference,
		retained = false,
		admission = false,
	): AgentContext {
		const candidates = grants.filter(
			(item) =>
				(item.purpose === "live-files" || (retained && item.purpose === "retained-context")) &&
				item.status === "active" &&
				item.expiresAt > Date.now() &&
				item.rootId === args.rootId &&
				sameModel(item.model, model) &&
				item.pathPrefixes.some((path) => covers(path, args.path)),
		);
		const grant =
			(retained ? candidates.find((item) => item.purpose === "retained-context") : undefined) ?? candidates[0];
		if (!grant || (state.cancelled && !admission)) throw new AppError("UNAUTHORIZED");
		return grant;
	}
	async #call(tx: Tx, call: Call): Promise<string[]> {
		const task = await tx.task(call.taskId);
		if (
			!task ||
			task.kind !== "pi.tool" ||
			task.conversationId !== call.conversationId ||
			task.abortRequested ||
			task.state.status === "terminal" ||
			task.state.status === "completing"
		)
			throw new AppError("UNAUTHORIZED");
		const input = task.input;
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			input.kind !== "model" ||
			input.callId !== call.callId
		)
			throw new AppError("UNAUTHORIZED");
		const live = await tx.doc(LiveDoc, call.conversationId);
		if (!live.run || live.run.inputs.length === 0 || task.owner !== live.run.taskId)
			throw new AppError("UNAUTHORIZED");
		const owner = await tx.task(live.run.taskId);
		if (!owner || owner.abortRequested || owner.kind !== "pi.generation") throw new AppError("UNAUTHORIZED");
		return live.run.inputs.map(String);
	}
	async authorize(id: ConversationId, input: AgentContextRequest): Promise<AgentContext> {
		const result = await this.locked(id, () =>
			this.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(id), null);
				const record = await this.#command(tx, id, state, input.requestId);
				const digest = hash(JSON.stringify(input));
				if (record.value) {
					if (record.value.kind !== "authorize" || record.value.digest !== digest)
						throw new AppError("IDEMPOTENCY_CONFLICT");
					return copy(await this.#storedGrant(tx, id, state, record.value.resultId));
				}
				await this.#active(tx, state);
				await this.#root(input.rootId);
				if (
					input.workspaceId !== this.#workspaceId ||
					input.conversationId !== state.publicId ||
					!sameModel(await this.#model(tx, id), input.model)
				)
					throw new AppError("UNAUTHORIZED");
				if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 86400000)
					throw new AppError("INVALID_REQUEST");
				const grants = await this.#grants(tx, id, state);
				if (grants.length >= 32) throw new AppError("CAPACITY_EXCEEDED");
				const grant: AgentContext = {
					...input,
					purpose: "live-files",
					grantId: randomUUID(),
					revision: 1,
					status: "active",
				};
				const metadata = [...grants, grant]
					.filter((item) => item.purpose === "live-files")
					.map((item) => ({ rootId: item.rootId, pathPrefixes: item.pathPrefixes }));
				const policy = await this.#projectPolicy(tx, id);
				const budget = ROOT_METADATA_BYTES - (policy.mode === "default" ? PROJECT_METADATA_RESERVE : 0);
				if (Buffer.byteLength(JSON.stringify(metadata)) > budget || !fitsPayloadBudget([...grants, grant]))
					throw new AppError("CAPACITY_EXCEEDED");
				const stored = await tx.doc(GrantDoc, grant.grantId, null);
				stored.conversationId = id;
				stored.value = grant;
				state.grantIds.push(grant.grantId);
				await appendAudit(tx, id, state, "grant", grant.grantId);
				record.conversationId = id;
				record.publicId = state.publicId;
				record.value = {
					requestId: input.requestId,
					digest,
					kind: "authorize",
					resultId: grant.grantId,
					firstResult: copy(grant),
				};
				await this.#live(tx, state);
				return copy(grant);
			}, background),
		);
		this.#armExpiry(id, result);
		return result;
	}
	async authorizeRetained(id: ConversationId, input: RetainedContextRequest): Promise<AgentContext> {
		const result = await this.locked(id, () =>
			this.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(id), null);
				if (input.workspaceId !== this.#workspaceId || input.conversationId !== state.publicId)
					throw new AppError("UNAUTHORIZED");
				const digest = hash(JSON.stringify(input));
				const record = await this.#command(tx, id, state, input.requestId);
				if (record.value) {
					if (record.value.kind !== "authorize-retained" || record.value.digest !== digest)
						throw new AppError("IDEMPOTENCY_CONFLICT");
					return copy(await this.#storedGrant(tx, id, state, record.value.resultId));
				}
				await this.#active(tx, state);
				let source: AgentContext;
				try {
					source = await this.#storedGrant(tx, id, state, input.sourceGrantId);
				} catch {
					throw new AppError("UNAUTHORIZED");
				}
				if (source.purpose !== "live-files" || !sameModel(await this.#model(tx, id), input.model))
					throw new AppError("UNAUTHORIZED");
				if (
					input.disclosureVersion !== 1 ||
					input.expiresAt <= Date.now() ||
					input.expiresAt > Date.now() + 86400000
				)
					throw new AppError("INVALID_REQUEST");
				const grants = await this.#grants(tx, id, state);
				if (grants.length >= 32) throw new AppError("CAPACITY_EXCEEDED");
				const grant: AgentContext = {
					...input,
					purpose: "retained-context",
					rootId: source.rootId,
					pathPrefixes: copy(source.pathPrefixes),
					grantId: randomUUID(),
					revision: 1,
					status: "active",
				};
				if (!fitsPayloadBudget([...grants, grant])) throw new AppError("CAPACITY_EXCEEDED");
				const stored = await tx.doc(GrantDoc, grant.grantId, null);
				stored.conversationId = id;
				stored.value = grant;
				state.grantIds.push(grant.grantId);
				await appendAudit(tx, id, state, "grant", grant.grantId);
				record.conversationId = id;
				record.publicId = state.publicId;
				record.value = {
					requestId: input.requestId,
					digest,
					kind: "authorize-retained",
					resultId: grant.grantId,
					firstResult: copy(grant),
				};
				await this.#live(tx, state);
				return copy(grant);
			}, background),
		);
		this.#armExpiry(id, result);
		return result;
	}
	#armExpiry(id: ConversationId, grant: AgentContext): void {
		if (this.#closed.signal.aborted || grant.status !== "active" || this.#expiry.has(grant.grantId)) return;
		const timer = setTimeout(
			() => {
				this.#expiry.delete(grant.grantId);
				void this.locked(id, async () => {
					let blocked = false;
					try {
						const grants = await this.activeContexts(id);
						// Timers and persisted wall-clock deadlines can diverge. Keep watching a still-active grant.
						const pending = grants.find((value) => value.grantId === grant.grantId);
						if (pending) this.#armExpiry(id, pending);
						const active = this.#inflight.get(id);
						// Every in-flight request keeps its actual dispatch model, never a later configuration.
						const models = active?.size
							? [...active.values()]
							: [await this.harness.commit((tx) => this.#model(tx, id), background)];
						for (const model of models) {
							try {
								const authority = await this.#dispatchAllowed(id, model);
								if (authority.expiresAt <= Date.now()) throw new AppError("UNAUTHORIZED");
								for (const rootId of authority.roots) this.files().assertRoot(this.#workspaceId, rootId);
							} catch {
								blocked = true;
								for (const [controller, dispatchedModel] of active ?? [])
									if (sameModel(dispatchedModel, model)) controller.abort(new AppError("UNAUTHORIZED"));
							}
						}
					} catch {
						// Storage failures cannot leave a stream authorized after its only expiry wake was consumed.
						this.interruptLocked(id);
						blocked = true;
					}
					if (blocked) await this.#abortConversation(id);
				}).catch(() => undefined);
			},
			Math.max(1, grant.expiresAt - Date.now()),
		);
		timer.unref();
		this.#expiry.set(grant.grantId, timer);
	}
	async #abortConversation(id: ConversationId): Promise<void> {
		// These APIs mark only this conversation and never resume a paused workspace.
		const inspection = await this.harness.inspect(background);
		for (const { record } of inspection.tasks)
			if (record.conversationId === id) await this.harness.abortTask(record.id, background);
		for (const submission of inspection.submissions)
			if (submission.conversationId === id && submission.status === "queued")
				await this.harness.abortSubmission(submission.id, background, id);
	}
	async revoke(id: ConversationId, input: Params<"revokeAgentContext">): Promise<AgentContext> {
		const result = await this.locked(id, async () => {
			// Revocation must still succeed when the host is unavailable. Never guess which old root was a project.
			const project = await this.#currentProject().catch(() => null);
			const liveRoots = await this.#files?.()
				?.listRoots(this.#workspaceId)
				.catch(() => []);
			const result = await this.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(id), null);
				const record = await this.#command(tx, id, state, input.requestId);
				const digest = hash(JSON.stringify(input));
				const grant = await this.#storedGrant(tx, id, state, input.grantId);
				if (record.value) {
					if (record.value.kind !== "revoke" || record.value.digest !== digest)
						throw new AppError("IDEMPOTENCY_CONFLICT");
					return copy(grant);
				}
				if (grant.status !== "revoked") {
					if (grant.revision !== input.expectedRevision) throw new AppError("IDEMPOTENCY_CONFLICT");
					grant.status = "revoked";
					grant.revision++;
				}
				if (grant.purpose === "live-files") {
					const policy = await this.#projectPolicy(tx, id);
					if (project?.root.rootId === grant.rootId) policy.blockedBindingId = project.bindingId;
					else if (!project || !liveRoots?.some((root) => root.rootId === grant.rootId))
						policy.mode = "restricted";
				}
				record.conversationId = id;
				record.publicId = state.publicId;
				record.value = {
					requestId: input.requestId,
					digest,
					kind: "revoke",
					resultId: grant.grantId,
					firstResult: copy(grant),
				};
				state.grantIds = state.grantIds.filter((key) => key !== grant.grantId);
				for (const key of [...state.pendingIds]) {
					const approval = (await tx.doc(ApprovalDoc, key, null)).value;
					if (
						approval?.grantId === grant.grantId &&
						(approval.status === "pending" || approval.status === "approved")
					) {
						approval.status = "invalidated";
						approval.revision++;
						state.pendingIds = state.pendingIds.filter((item) => item !== key);
					}
				}
				await this.#live(tx, state);
				return copy(grant);
			}, background);
			for (const controller of this.#inflight.get(id)?.keys() ?? []) controller.abort(new AppError("UNAUTHORIZED"));
			clearTimeout(this.#expiry.get(result.grantId));
			this.#expiry.delete(result.grantId);
			return result;
		});
		await this.#abortConversation(id).catch(() => undefined);
		return result;
	}
	async activeContexts(id: ConversationId): Promise<AgentContext[]> {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			return copy(await this.#grants(tx, id, state));
		}, background);
	}
	async contexts(id: ConversationId, cursor?: string) {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			const generation = this.#hooks ? await this.#hooks.auditGeneration(tx) : state.sessionId;
			const page = auditPosition(generation, this.#workspaceId, state.publicId, "grant", state.grantCount, cursor);
			const items: AgentContext[] = [];
			while (page.position > 0 && items.length < 64) {
				const key = await auditId(tx, id, "grant", page.position - 1);
				const grant = await this.#storedGrant(tx, id, state, key);
				if (grant.status === "active" && grant.expiresAt <= Date.now()) {
					grant.status = "expired";
					grant.revision++;
				}
				if (!fitsPayloadBudget({ items: [...items, grant], nextCursor: "x".repeat(2048) })) break;
				items.push(copy(grant));
				page.position--;
			}
			if (items.length === 0 && page.position > 0) throw new AppError("CAPACITY_EXCEEDED");
			return {
				items,
				nextCursor: auditCursor(generation, this.#workspaceId, state.publicId, "grant", page.upper, page.position),
			};
		}, background);
	}
	async commandResult(id: ConversationId, requestId: string): Promise<Result<"getAgentCommandResult">> {
		return this.locked(id, async () => {
			const state = await this.harness.snapshot(ContextDoc, String(id), background);
			if (!state?.publicId) throw new AppError("UNAUTHORIZED");
			return resolveAgentCommandResult(
				async (kind, key) => {
					if (kind === "hipi.agent-context.v2") return this.harness.snapshot(ContextDoc, key, background);
					if (kind === "hipi.agent-command") return this.harness.snapshot(CommandDoc, key, background);
					if (kind === "hipi.agent-grant") return this.harness.snapshot(GrantDoc, key, background);
					if (kind === "hipi.tool-approval") return this.harness.snapshot(ApprovalDoc, key, background);
					throw new AppError("INTERNAL");
				},
				this.#workspaceId,
				state.publicId,
				id,
				requestId,
			);
		});
	}
	async cancel(id: ConversationId): Promise<void> {
		await this.locked(id, async () => {
			await this.harness.commit((tx) => this.invalidateInTransaction(tx, id), background);
			for (const controller of this.#inflight.get(id)?.keys() ?? []) controller.abort(new AppError("UNAUTHORIZED"));
		});
	}
	/** Use in the same transaction as a package revocation while holding this conversation's effect lock. */
	async invalidateInTransaction(tx: Tx, id: ConversationId): Promise<void> {
		const state = await tx.doc(ContextDoc, String(id), null);
		state.cancelled = true;
		for (const key of state.pendingIds) {
			const value = (await tx.doc(ApprovalDoc, key, null)).value;
			if (value && (value.status === "pending" || value.status === "approved")) {
				value.status = "invalidated";
				value.revision++;
			}
		}
		state.pendingIds = [];
		await this.#live(tx, state);
	}
	async submitted(tx: Tx, id: ConversationId): Promise<void> {
		(await tx.doc(ContextDoc, String(id), null)).cancelled = false;
	}
	async #session(sessionId: string): Promise<ConversationId> {
		const binding = await this.harness.snapshot(BindingDoc, bindingKey(sessionId), background);
		if (!binding || binding.sessionId !== sessionId || !binding.conversationId) throw new AppError("UNAUTHORIZED");
		return binding.conversationId as ConversationId;
	}
	async #dispatchAllowed(
		id: ConversationId,
		model: ModelReference,
		descriptors?: readonly PackageDescriptor[],
		dispatch = false,
	): Promise<{ roots: string[]; expiresAt: number }> {
		const current = await this.#currentProject();
		const authority = await this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			await this.#active(tx, state);
			if (!state.publicId || state.cancelled || !sameModel(await this.#model(tx, id), model))
				throw new AppError("UNAUTHORIZED");
			await this.#extensions?.register(tx, id, state.publicId);
			let expiresAt =
				(await this.#extensions?.assertContext(tx, id, model, dispatch ? "dispatch" : "admission", descriptors)) ??
				Number.MAX_SAFE_INTEGER;
			if (state.cancelled) throw new AppError("UNAUTHORIZED");
			const roots = new Set<string>();
			const grants = await this.#grants(tx, id, state);
			const project = await this.#project(tx, id, state, current);
			for (const dependency of state.dependencies) {
				const authority = this.#dependency(state, grants, dependency, model, project);
				expiresAt = Math.min(expiresAt, authority.expiresAt);
				if (authority.rootId) roots.add(authority.rootId);
			}
			return { roots: [...roots], expiresAt };
		}, background);
		for (const rootId of authority.roots) await this.#root(rootId);
		return authority;
	}
	async check(sessionId: string, model: Model<Api>, descriptors?: readonly PackageDescriptor[]): Promise<void> {
		const id = await this.#session(sessionId);
		await this.locked(id, async () => {
			const authority = await this.#dispatchAllowed(
				id,
				{ provider: model.provider, modelId: model.id },
				descriptors,
			);
			if (authority.expiresAt <= Date.now()) throw new AppError("UNAUTHORIZED");
			for (const rootId of authority.roots) this.files().assertRoot(this.#workspaceId, rootId);
		});
	}
	/** Admission gives the user a stable recovery action; final model dispatch still rechecks. */
	async assertContext(id: ConversationId): Promise<void> {
		try {
			await this.locked(id, async () => {
				const current = await this.#currentProject();
				const roots = await this.harness.commit(async (tx) => {
					const state = await tx.doc(ContextDoc, String(id), null);
					const model = await this.#model(tx, id);
					await this.#extensions?.register(tx, id, state.publicId);
					await this.#extensions?.assertContext(tx, id, model, "admission");
					await this.#active(tx, state);
					const roots = new Set<string>();
					const grants = await this.#grants(tx, id, state);
					const project = await this.#project(tx, id, state, current, true);
					for (const item of state.dependencies) {
						const authority = this.#dependency(state, grants, item, model, project, true);
						if (authority.rootId) roots.add(authority.rootId);
					}
					return [...roots];
				}, background);
				for (const root of roots) await this.#root(root);
			});
		} catch {
			throw new AppError("CONTEXT_AUTHORIZATION_REQUIRED");
		}
	}
	async promptContext(id: ConversationId): Promise<string | undefined> {
		return this.locked(id, async () => {
			const current = await this.#currentProject();
			return this.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(id), null);
				const model = await this.#model(tx, id);
				await this.#active(tx, state);
				const project = await this.#project(tx, id, state, current);
				const grants = (await this.#grants(tx, id, state)).filter((grant) => {
					if (
						grant.rootId === project?.root.rootId ||
						grant.purpose !== "live-files" ||
						grant.status !== "active" ||
						grant.expiresAt <= Date.now() ||
						!sameModel(grant.model, model)
					)
						return false;
					try {
						this.files().assertRoot(this.#workspaceId, grant.rootId);
						return true;
					} catch {
						// Retained disclosure may authorize history, never discovery of an invalid host root.
						return false;
					}
				});
				if (state.cancelled) return undefined;
				if (!grants.length && !project)
					return "No live file roots are available for this chat and model. File root IDs come only from app context: never invent them or ask the user to type internal rootId values or absolute host paths. Project files require an available connected project folder; additional folders require explicit file-context permission in the app. Do not call file tools until roots are supplied.";
				const roots = grants.map((grant) => ({ rootId: grant.rootId, pathPrefixes: grant.pathPrefixes }));
				if (project) {
					this.files().assertRoot(this.#workspaceId, project.root.rootId);
					roots.unshift({ rootId: project.root.rootId, pathPrefixes: [""] });
					this.#recordDependency(state, { rootId: project.root.rootId, path: "" }, project);
				}
				const prompt = JSON.stringify(roots);
				if (Buffer.byteLength(prompt) > ROOT_METADATA_BYTES) throw new AppError("CAPACITY_EXCEEDED");
				for (const grant of grants)
					for (const path of grant.pathPrefixes) this.#recordDependency(state, { rootId: grant.rootId, path });
				return `Authorized file roots and relative path prefixes: ${prompt}. Only use the hipi_files tools. Read paginated content; saving requires explicit per-call approval.`;
			}, background);
		});
	}
	async #access(
		call: Call,
		args: ReadArgs,
		recordDependency = false,
		projectRead = false,
	): Promise<AgentContext | undefined> {
		validateRelativePath(args.path, true);
		await this.#root(args.rootId);
		const current = projectRead ? await this.#currentProject() : null;
		return this.harness.commit(async (tx) => {
			await this.#call(tx, call);
			await this.#extensions?.register(
				tx,
				call.conversationId,
				(await tx.doc(ContextDoc, String(call.conversationId), null)).publicId,
			);
			await this.#extensions?.assertContext(
				tx,
				call.conversationId,
				await this.#model(tx, call.conversationId),
				"tool",
			);
			const state = await tx.doc(ContextDoc, String(call.conversationId), null);
			await this.#active(tx, state);
			const project = await this.#project(tx, call.conversationId, state, current);
			if (state.cancelled) throw new AppError("UNAUTHORIZED");
			if (project && args.rootId === project.root.rootId) {
				this.files().assertRoot(this.#workspaceId, args.rootId);
				if (recordDependency) this.#recordDependency(state, args, project);
				return undefined;
			}
			const grant = this.#grant(
				state,
				await this.#grants(tx, call.conversationId, state),
				args,
				await this.#model(tx, call.conversationId),
			);
			if (recordDependency) this.#recordDependency(state, args);
			return copy(grant);
		}, background);
	}
	async read(call: Call, args: ReadArgs & { offset?: number; revision?: string }) {
		validateRelativePath(args.path);
		await this.#access(call, args, false, true);
		const value = await this.files().readText({
			workspaceId: this.#workspaceId,
			rootId: args.rootId,
			path: args.path,
		});
		if (args.revision !== undefined && args.revision !== value.revision)
			throw new FileServiceError("VERSION_CONFLICT");
		const offset = args.offset ?? 0;
		if (offset > value.text.length || (offset > 0 && /[\udc00-\udfff]/u.test(value.text[offset] ?? "")))
			throw new AppError("INVALID_REQUEST");
		if (offset > 0 && !args.revision) throw new AppError("INVALID_REQUEST");
		let text = "";
		let bytes = 0;
		for (const char of value.text.slice(offset)) {
			const size = Buffer.byteLength(char);
			if (bytes + size > 8192) break;
			text += char;
			bytes += size;
		}
		await this.locked(call.conversationId, () => this.#access(call, args, true, true));
		const next = offset + text.length;
		return {
			text,
			revision: value.revision,
			offset,
			nextOffset: next < value.text.length ? next : null,
			textLength: value.text.length,
		};
	}
	async list(call: Call, args: ReadArgs & { cursor?: string }) {
		await this.#access(call, args, false, true);
		const page = await this.files().list(
			{ workspaceId: this.#workspaceId, rootId: args.rootId, path: args.path },
			args.cursor,
		);
		// The file service's cursor binds directory/version; keep it intact rather than silently dropping entries.
		if (Buffer.byteLength(JSON.stringify(page)) > 16384) throw new AppError("CAPACITY_EXCEEDED");
		await this.locked(call.conversationId, () => this.#access(call, args, true, true));
		return page;
	}
	async prepare(call: Call, args: SaveArgs, context: Context): Promise<void> {
		validateRelativePath(args.path);
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(args.text)) throw new AppError("INVALID_REQUEST");
		if (Buffer.byteLength(args.text) > 65536) throw new AppError("CAPACITY_EXCEEDED");
		await this.#root(args.rootId, true);
		const grant = await this.#access(call, args);
		if (!grant) throw new AppError("UNAUTHORIZED");
		const before = await this.files().readText({
			workspaceId: this.#workspaceId,
			rootId: args.rootId,
			path: args.path,
		});
		if (before.revision !== args.ifMatch) throw new FileServiceError("VERSION_CONFLICT");
		const scope = await this.#scope(call.conversationId);
		const key = hash(JSON.stringify([call.conversationId, call.taskId, call.callId]));
		await this.locked(call.conversationId, () =>
			this.harness.commit(async (tx) => {
				const submissionIds = await this.#call(tx, call);
				const state = await tx.doc(ContextDoc, String(call.conversationId), null);
				await this.#active(tx, state);
				const current = this.#grant(
					state,
					await this.#grants(tx, call.conversationId, state),
					args,
					await this.#model(tx, call.conversationId),
				);
				if (current.grantId !== grant.grantId || current.revision !== grant.revision)
					throw new AppError("UNAUTHORIZED");
				const record = await tx.doc(ApprovalDoc, key, null);
				if (record.value) {
					if (record.value.argumentsDigest !== argsHash(args)) throw new AppError("IDEMPOTENCY_CONFLICT");
					return;
				}
				for (const pending of [...state.pendingIds]) await this.#approval(tx, state, pending);
				if (state.pendingIds.length >= 8 || state.operationIds.length >= 32)
					throw new AppError("CAPACITY_EXCEEDED");
				let beforeText = "";
				for (const char of before.text) {
					if (Buffer.byteLength(beforeText + char) > 4096) break;
					beforeText += char;
				}
				record.value = parseToolApproval({
					...scope,
					approvalId: key,
					taskId: String(call.taskId),
					callId: call.callId,
					submissionIds,
					receiptIds: await this.#receipts(tx, submissionIds, state.publicId),
					toolName: "hipi_files_save",
					model: grant.model,
					...args,
					beforeText,
					beforeTextTruncated: beforeText.length < before.text.length,
					argumentsDigest: argsHash(args),
					contentDigest: hash(args.text),
					grantId: grant.grantId,
					grantRevision: grant.revision,
					expiresAt: Math.min(grant.expiresAt, Date.now() + 300000),
					createdAt: Date.now(),
					revision: 1,
					status: "pending",
				});
				state.pendingIds.push(key);
				await appendAudit(tx, call.conversationId, state, "approval", key);
				await this.#live(tx, state);
			}, background),
		);
		// Native document watching never resumes PI and avoids polling the writer while the user decides.
		const watch = await this.harness.watchDoc(ApprovalDoc, key, context);
		if (!watch) throw new AppError("NOT_FOUND");
		const wake = Promise.withResolvers<void>();
		const abort = () => wake.resolve();
		const deadline = watch.value?.value?.expiresAt ?? Date.now();
		const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
		context.abortSignal?.addEventListener("abort", abort, { once: true });
		this.#closed.signal.addEventListener("abort", abort, { once: true });
		try {
			watch.start(async (value) => {
				if (value?.value?.status !== "pending") wake.resolve();
			});
			void watch.closed.then(abort);
			if (watch.value?.value?.status !== "pending" || context.abortSignal?.aborted || this.#closed.signal.aborted)
				wake.resolve();
			await wake.promise;
			if (context.abortSignal?.aborted || this.#closed.signal.aborted) throw new AppError("UNAUTHORIZED");
			if ((await this.#refresh(call.conversationId, key)).status !== "approved") throw new AppError("UNAUTHORIZED");
		} finally {
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", abort);
			this.#closed.signal.removeEventListener("abort", abort);
			await watch.stop();
		}
	}
	async #approval(tx: Tx, state: AuthorizationState, key: string): Promise<ToolApproval> {
		const value = (await tx.doc(ApprovalDoc, key, null)).value;
		if (!value || value.conversationId !== state.publicId || value.workspaceId !== this.#workspaceId)
			throw new AppError("NOT_FOUND");
		if ((value.status === "pending" || value.status === "approved") && value.expiresAt <= Date.now()) {
			value.status = "expired";
			value.revision++;
		}
		if (value.status !== "pending" && value.status !== "approved") {
			state.pendingIds = state.pendingIds.filter((item) => item !== key);
			await this.#live(tx, state);
		}
		return value;
	}
	async #refresh(id: ConversationId, key: string): Promise<ToolApproval> {
		return this.harness.commit(
			async (tx) => copy(await this.#approval(tx, await tx.doc(ContextDoc, String(id), null), key)),
			background,
		);
	}
	async approvals(id: ConversationId, cursor?: string) {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			const generation = this.#hooks ? await this.#hooks.auditGeneration(tx) : state.sessionId;
			const page = auditPosition(
				generation,
				this.#workspaceId,
				state.publicId,
				"approval",
				state.approvalCount,
				cursor,
			);
			const items: ToolApproval[] = [];
			if (page.position > 0) {
				items.push(copy(await this.#approval(tx, state, await auditId(tx, id, "approval", --page.position))));
			}
			return {
				items,
				nextCursor: auditCursor(
					generation,
					this.#workspaceId,
					state.publicId,
					"approval",
					page.upper,
					page.position,
				),
			};
		}, background);
	}
	async pendingApprovals(id: ConversationId, cursor?: string) {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(ContextDoc, String(id), null);
			const generation = this.#hooks ? await this.#hooks.auditGeneration(tx) : state.sessionId;
			const values: ToolApproval[] = [];
			for (const key of [...state.pendingIds]) {
				const value = await this.#approval(tx, state, key);
				if (value.status === "pending" || value.status === "approved") values.push(copy(value));
			}
			const revision = hash(JSON.stringify(values.map((value) => [value.approvalId, value.revision])));
			const page = auditPosition(
				generation,
				this.#workspaceId,
				state.publicId,
				`pending-${revision}`,
				values.length,
				cursor,
			);
			const items = page.position > 0 ? [values[--page.position]] : [];
			return {
				items,
				nextCursor: auditCursor(
					generation,
					this.#workspaceId,
					state.publicId,
					`pending-${revision}`,
					page.upper,
					page.position,
				),
			};
		}, background);
	}
	async decide(id: ConversationId, input: Params<"decideToolApproval">): Promise<ToolApproval> {
		await this.#refresh(id, input.approvalId);
		return this.locked(id, () =>
			this.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(id), null);
				const value = await this.#approval(tx, state, input.approvalId);
				const digest = hash(JSON.stringify(input));
				const record = await this.#command(tx, id, state, input.requestId);
				if (record.value) {
					if (record.value.kind !== "decide" || record.value.digest !== digest)
						throw new AppError("IDEMPOTENCY_CONFLICT");
					return copy(value);
				}
				await this.#active(tx, state);
				if (
					value.revision !== input.expectedRevision ||
					value.argumentsDigest !== input.argumentsDigest ||
					value.contentDigest !== input.contentDigest
				)
					throw new AppError("IDEMPOTENCY_CONFLICT");
				if (value.status !== "pending" || value.expiresAt <= Date.now()) throw new AppError("UNAUTHORIZED");
				await this.#call(tx, { conversationId: id, taskId: Number(value.taskId) as TaskId, callId: value.callId });
				const grant = this.#grant(state, await this.#grants(tx, id, state), value, await this.#model(tx, id));
				if (grant.grantId !== value.grantId || grant.revision !== value.grantRevision)
					throw new AppError("UNAUTHORIZED");
				value.status = input.decision === "approve" ? "approved" : "rejected";
				value.revision++;
				record.conversationId = id;
				record.publicId = state.publicId;
				record.value = {
					requestId: input.requestId,
					digest,
					kind: "decide",
					resultId: value.approvalId,
					firstResult: copy(value),
				};
				if (value.status === "rejected")
					state.pendingIds = state.pendingIds.filter((key) => key !== value.approvalId);
				await this.#live(tx, state);
				return copy(value);
			}, background),
		);
	}
	async save(call: Call, args: SaveArgs, context: Context) {
		const key = hash(JSON.stringify([call.conversationId, call.taskId, call.callId]));
		await this.#access(call, args);
		const operationId = randomUUID();
		await this.locked(call.conversationId, () =>
			this.harness.commit(async (tx) => {
				await this.#call(tx, call);
				const state = await tx.doc(ContextDoc, String(call.conversationId), null);
				await this.#active(tx, state);
				const grant = this.#grant(
					state,
					await this.#grants(tx, call.conversationId, state),
					args,
					await this.#model(tx, call.conversationId),
				);
				const approval = (await tx.doc(ApprovalDoc, key, null)).value;
				if (
					context.abortSignal?.aborted ||
					!approval ||
					approval.status !== "approved" ||
					approval.expiresAt <= Date.now() ||
					approval.argumentsDigest !== argsHash(args) ||
					approval.grantId !== grant.grantId ||
					approval.grantRevision !== grant.revision
				)
					throw new AppError("UNAUTHORIZED");
				if (state.operationIds.length >= 32) throw new AppError("CAPACITY_EXCEEDED");
				state.pendingIds = state.pendingIds.filter((item) => item !== key);
				state.operationIds.push(operationId);
				await appendAudit(tx, call.conversationId, state, "operation", operationId);
				await this.#live(tx, state);
				approval.status = "consumed";
				approval.revision++;
				approval.operationId = operationId;
				(await tx.doc(OperationDoc, operationId, null)).value = {
					workspaceId: this.#workspaceId,
					conversationId: state.publicId,
					operationId,
					approvalId: key,
					taskId: String(call.taskId),
					callId: call.callId,
					rootId: args.rootId,
					path: args.path,
					argumentsDigest: argsHash(args),
					contentDigest: hash(args.text),
					status: "executing",
					revision: 1,
				};
			}, background),
		);
		try {
			const saved = await this.files().saveText(
				{ workspaceId: this.#workspaceId, rootId: args.rootId, path: args.path },
				args.text,
				args.ifMatch,
				(commit) =>
					this.locked(call.conversationId, async () => {
						if (context.abortSignal?.aborted || this.#closed.signal.aborted)
							throw new FileServiceError("UNAUTHORIZED");
						try {
							const grant = await this.#access(call, args, true);
							const approval = await this.#refresh(call.conversationId, key);
							if (
								!grant ||
								approval.status !== "consumed" ||
								approval.operationId !== operationId ||
								approval.expiresAt <= Date.now() ||
								approval.grantId !== grant.grantId ||
								approval.grantRevision !== grant.revision
							)
								throw new AppError("UNAUTHORIZED");
						} catch {
							throw new FileServiceError("UNAUTHORIZED");
						}
						return commit();
					}),
			);
			await this.harness.commit(async (tx) => {
				const value = (await tx.doc(OperationDoc, operationId, null)).value;
				if (!value) throw new AppError("INTERNAL");
				const state = await tx.doc(ContextDoc, String(call.conversationId), null);
				state.operationIds = state.operationIds.filter((key) => key !== operationId);
				await this.#live(tx, state);
				value.status = "confirmed";
				value.revision++;
				value.evidence = { revision: saved.revision, contentDigest: hash(saved.text) };
			}, background);
			return { operationId, status: "confirmed", revision: saved.revision, bytes: saved.bytes };
		} catch (error) {
			await this.harness.commit(async (tx) => {
				const value = (await tx.doc(OperationDoc, operationId, null)).value;
				if (value) {
					value.status =
						error instanceof FileServiceError && error.code === "VERSION_CONFLICT" ? "conflict" : "unknown";
					if (value.status === "conflict") {
						const state = await tx.doc(ContextDoc, String(call.conversationId), null);
						state.operationIds = state.operationIds.filter((key) => key !== operationId);
						await this.#live(tx, state);
					}
					value.revision++;
				}
			}, background);
			throw error;
		}
	}
	async operation(id: ConversationId, input: Params<"getFileOperation">): Promise<FileOperation | null> {
		const scope = await this.#scope(id);
		let value = (await this.harness.snapshot(OperationDoc, input.operationId, background))?.value;
		if (!value || value.conversationId !== scope.conversationId || value.workspaceId !== this.#workspaceId)
			return null;
		if (input.reconcile && value.status === "unknown") {
			const target = value;
			await this.locked(id, async () => {
				await this.#root(target.rootId);
				await this.harness.commit(async (tx) => {
					const state = await tx.doc(ContextDoc, String(id), null);
					await this.#active(tx, state);
					this.#grant(state, await this.#grants(tx, id, state), target, await this.#model(tx, id));
				}, background);
				const observed = await this.files().readText({
					workspaceId: this.#workspaceId,
					rootId: target.rootId,
					path: target.path,
				});
				await this.harness.commit(async (tx) => {
					const stored = (await tx.doc(OperationDoc, input.operationId, null)).value;
					if (!stored || stored.status !== "unknown") return;
					stored.status = hash(observed.text) === stored.contentDigest ? "observed_match" : "unknown";
					stored.evidence = { revision: observed.revision, contentDigest: hash(observed.text) };
					stored.revision++;
				}, background);
			});
			value = (await this.harness.snapshot(OperationDoc, input.operationId, background))?.value;
		}
		return value ? copy(value) : null;
	}
	async start(
		sessionId: string,
		model: Model<Api>,
		controller: AbortController,
		dispatch: () => Promise<Response>,
		descriptors?: readonly PackageDescriptor[],
	) {
		const id = await this.#session(sessionId);
		const requestModel = { provider: model.provider, modelId: model.id };
		return this.locked(id, async () => {
			const authority = await this.#dispatchAllowed(id, requestModel, descriptors, true);
			if (controller.signal.aborted) throw new AppError("UNAUTHORIZED");
			const active = this.#inflight.get(id) ?? new Map<AbortController, ModelReference>();
			active.set(controller, requestModel);
			this.#inflight.set(id, active);
			const release = () => {
				active.delete(controller);
				if (active.size === 0) this.#inflight.delete(id);
			};
			try {
				if (authority.expiresAt <= Date.now()) throw new AppError("UNAUTHORIZED");
				for (const rootId of authority.roots) this.files().assertRoot(this.#workspaceId, rootId);
				return { response: dispatch(), release };
			} catch (error) {
				release();
				throw error;
			}
		});
	}
	close(): void {
		this.#closed.abort();
		for (const timer of this.#expiry.values()) clearTimeout(timer);
		this.#expiry.clear();
		for (const active of this.#inflight.values()) for (const controller of active.keys()) controller.abort();
	}
}

/** Only this fixed extension is installed; renderer/plugin input cannot replace its names or hard gates. */
export function agentRegistry(broker: AgentToolBroker) {
	const target = { rootId: Type.String({ minLength: 1, maxLength: 128 }), path: Type.String({ maxLength: 2048 }) };
	const read = defineTool({
		name: "hipi_files_read",
		description:
			"Read an authorized existing UTF-8 file, at most 8 KiB per page. Offsets are UTF-16 units; continuation requires the returned revision.",
		parameters: Type.Object(
			{
				...target,
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
			},
			{ additionalProperties: false },
		),
		callers: ["model"],
		replay: "safe",
		outputLimits: { maxBytes: 20000 },
		execute: async (args, api) => {
			const value = await broker.read(api, args);
			const details = filePresentationDetails({ rootId: args.rootId, path: args.path }, { kind: "read", ...value });
			return { output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(details ? { details } : {}) };
		},
	});
	const list = defineTool({
		name: "hipi_files_list",
		description: "List an authorized directory. Follow nextCursor until null; an empty path lists the root.",
		parameters: Type.Object(
			{ ...target, cursor: Type.Optional(Type.String({ maxLength: 2048 })) },
			{ additionalProperties: false },
		),
		callers: ["model"],
		replay: "safe",
		outputLimits: { maxBytes: 16384 },
		execute: async (args, api) => {
			const value = await broker.list(api, args);
			const details = filePresentationDetails(
				{ rootId: args.rootId, path: args.path },
				{ kind: "directory", entries: value.entries, hasMore: value.nextCursor !== null },
			);
			return { output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(details ? { details } : {}) };
		},
	});
	const save = defineTool({
		name: "hipi_files_save",
		description:
			"Propose replacement of an existing UTF-8 file (maximum 64 KiB); waits for one explicit user decision, requires exact read revision. Never retry an unknown write automatically.",
		parameters: Type.Object(
			{ ...target, text: Type.String({ maxLength: 65536 }), ifMatch: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
			{ additionalProperties: false },
		),
		callers: ["model"],
		replay: "unsafe",
		outputLimits: { maxBytes: 2048 },
		execute: async (args, api, context) => {
			const value = await broker.save(api, args, context);
			const details = filePresentationDetails(
				{ rootId: args.rootId, path: args.path },
				{ kind: "save", operationId: value.operationId, revision: value.revision, bytes: value.bytes },
			);
			return { output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(details ? { details } : {}) };
		},
	});
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "hipi.files",
			tools: [read, list, save],
			sections: [section("hipi-authorized-files", (input) => broker.promptContext(input.conversationId))],
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						if (call.name !== "hipi_files_save") return;
						// PI validates the registered schema before this hook. Parse again without trusting assertions.
						const args = call.arguments;
						if (
							typeof args.rootId !== "string" ||
							typeof args.path !== "string" ||
							typeof args.text !== "string" ||
							typeof args.ifMatch !== "string"
						)
							return { block: "INVALID_REQUEST" };
						await broker.prepare(
							{ conversationId: api.conversationId, taskId: api.taskId, callId: call.id },
							{ rootId: args.rootId, path: args.path, text: args.text, ifMatch: args.ifMatch },
							context,
						);
						return undefined;
					},
				}),
			],
		}),
	);
	return registry;
}
