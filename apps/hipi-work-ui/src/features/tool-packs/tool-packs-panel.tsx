import {
	type Conversation,
	PROTOCOL_VERSION,
	type ToolPackBinding,
	type ToolPackRecord,
} from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { toolPackLabels } from "./labels.ts";
import { validatePackageText } from "./recovery.ts";
import { bindingCapacity, bindingRequest, ToolPackSession } from "./session.ts";
import { ToolPackSource } from "./source-view.tsx";

type Authorization = { kind: "live"; pack: ToolPackRecord } | { kind: "retained"; binding: ToolPackBinding };

/** Own the session and drafts outside a dialog; inactive panels cancel reads without forgetting recovery. */
export function ToolPacksPanel({
	workspaceId,
	conversation,
	active,
	children,
}: {
	workspaceId: string;
	conversation?: Conversation;
	active: boolean;
	children: (content: ReactNode) => ReactNode;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const { locale } = usePreferences();
	const l = toolPackLabels(locale);
	const session = useMemo(
		() => new ToolPackSession(client, local, workspaceId, conversation?.conversationId),
		[client, local, workspaceId, conversation?.conversationId],
	);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [reading, setReading] = useState(false);
	const [target, setTarget] = useState<Authorization | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [duration, setDuration] = useState("900000");
	const generation = useRef(0);
	const textId = useId();
	const fileId = useId();
	const confirmationId = useId();
	const archived = conversation?.archivedAt != null;
	const modelQuery = useQuery({
		queryKey: ["tool-pack-model", workspaceId, conversation?.conversationId],
		queryFn: ({ signal }) =>
			client.call("getConversationModel", { workspaceId, conversationId: conversation?.conversationId ?? "" }, signal),
		enabled: active && !!conversation,
		retry: false,
	});
	const model = modelQuery.data?.model;
	useEffect(() => {
		session.activate();
		return () => {
			generation.current++;
			session.dispose();
		};
	}, [session]);
	useEffect(() => {
		session.setArchived(archived);
	}, [session, archived]);
	useEffect(() => {
		if (active) void session.refresh();
		else session.cancel();
	}, [session, active]);
	const disabled = state.busy || reading || state.failed || !!state.pending || state.incompatible || !state.loaded;
	const capacity = bindingCapacity(state.active, Date.now());
	const digest = target?.kind === "live" ? target.pack.digest : target?.binding.digest;
	const sourceReady = !!digest && state.source?.digest === digest;
	const date = (value: number) =>
		new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(value);
	const choose = (value: Authorization) => {
		setTarget(value);
		setConfirmed(false);
		void session.source(value.kind === "live" ? value.pack.digest : value.binding.digest);
	};
	return children(
		<div className="tool-packs-panel grid gap-4">
			<p className="text-sm text-muted-foreground">{l["toolPacks.description"]}</p>
			<p className="text-sm text-muted-foreground">{l["toolPacks.effects"]}</p>
			<Button
				variant="outline"
				disabled={state.busy || reading}
				onClick={() => {
					void session.refresh();
					if (conversation) void modelQuery.refetch();
				}}
			>
				{l["toolPacks.refresh"]}
			</Button>
			{(state.busy || reading) && <output aria-live="polite">{l["toolPacks.loading"]}</output>}
			{state.failed && <p role="alert">{l["toolPacks.failed"]}</p>}
			{state.incompatible && <p role="alert">{l["toolPacks.incompatible"]}</p>}
			{archived && <p>{l["toolPacks.archived"]}</p>}
			{state.pending && (
				<section className="grid gap-2 rounded-md border border-border p-3 text-sm">
					<output>{l["toolPacks.unknown"]}</output>
					<details>
						<summary>{l["toolPacks.original"]}</summary>
						<pre className="whitespace-pre-wrap break-all">{JSON.stringify(state.pending, null, 2)}</pre>
					</details>
					{state.notFound && <p>{l["toolPacks.notFound"]}</p>}
					{state.pending.install && <p>{l["toolPacks.reimport"]}</p>}
					<Button
						variant="outline"
						disabled={
							state.busy ||
							reading ||
							!state.notFound ||
							state.incompatible ||
							archived ||
							(!!state.pending.install && !text)
						}
						onClick={() => void session.retry(text)}
					>
						{l["toolPacks.retry"]}
					</Button>
				</section>
			)}
			<section className="grid gap-2 border-t border-border pt-3">
				<label htmlFor={fileId}>{l["toolPacks.import"]}</label>
				<input
					id={fileId}
					type="file"
					accept=".json,application/json"
					disabled={state.busy || reading}
					className="text-sm focus-visible:outline-ring"
					onChange={async (event) => {
						const file = event.target.files?.[0];
						if (!file) return;
						const current = generation.current;
						setReading(true);
						try {
							if (file.size > 65536) throw new Error("PACKAGE_TOO_LARGE");
							const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
							validatePackageText(value);
							if (generation.current !== current) return;
							setText(value);
							setInvalid(false);
							session.clearPreview();
						} catch {
							if (generation.current === current) setInvalid(true);
						} finally {
							if (generation.current === current) setReading(false);
						}
					}}
				/>
				<label htmlFor={textId}>{l["toolPacks.text"]}</label>
				<Textarea
					id={textId}
					value={text}
					maxLength={65536}
					rows={5}
					disabled={state.busy || reading}
					aria-invalid={invalid}
					className="font-mono"
					onChange={(event) => {
						setText(event.target.value);
						setInvalid(false);
						session.clearPreview();
					}}
				/>
				{invalid && <p role="alert">{l["toolPacks.invalid"]}</p>}
				<Button
					variant="outline"
					disabled={state.busy || reading || !text}
					onClick={() => {
						try {
							validatePackageText(text);
							setInvalid(false);
							void session.preview(text);
						} catch {
							setInvalid(true);
						}
					}}
				>
					{l["toolPacks.preview"]}
				</Button>
				{state.preview?.text === text && (
					<div className="grid gap-2 text-sm">
						<p className="font-medium">
							{state.preview.value.name} · {state.preview.value.version}
						</p>
						<p>{state.preview.value.description}</p>
						<p className="break-all">{state.preview.value.digest}</p>
						<p>{l["toolPacks.unverified"]}</p>
						<p>{l["toolPacks.installNote"]}</p>
						<Button
							disabled={disabled}
							onClick={() => {
								if (state.preview?.text === text)
									void session.execute({
										version: PROTOCOL_VERSION,
										method: "installToolPack",
										params: {
											workspaceId,
											requestId: crypto.randomUUID(),
											packageText: text,
											expectedDigest: state.preview.value.digest,
											disclosureVersion: 1,
										},
									});
							}}
						>
							{l["toolPacks.install"]}
						</Button>
					</div>
				)}
			</section>
			<section className="grid gap-2 border-t border-border pt-3">
				<h3 className="font-medium">{l["toolPacks.workspace"]}</h3>
				{state.loaded && !state.packs.length && <p>{l["toolPacks.empty"]}</p>}
				{state.packs.map((pack) => (
					<article key={pack.digest} className="grid gap-2 rounded-md border border-border p-3 text-sm">
						<p className="font-medium">
							{pack.name} · {pack.version} · {l[`toolPacks.status.${pack.status}`]}
						</p>
						<p>{pack.description}</p>
						<p className="break-all">{pack.digest}</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={state.busy}
								onClick={() => {
									setTarget(null);
									void session.source(pack.digest);
								}}
							>
								{l["toolPacks.source"]}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={disabled || pack.status === "uninstalled"}
								onClick={() =>
									void session.execute({
										version: PROTOCOL_VERSION,
										method: "setToolPackEnabled",
										params: {
											workspaceId,
											requestId: crypto.randomUUID(),
											digest: pack.digest,
											expectedRevision: pack.revision,
											enabled: pack.status !== "enabled",
										},
									})
								}
							>
								{l[pack.status === "enabled" ? "toolPacks.disable" : "toolPacks.enable"]}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={disabled || pack.status === "uninstalled"}
								onClick={() =>
									void session.execute({
										version: PROTOCOL_VERSION,
										method: "uninstallToolPack",
										params: {
											workspaceId,
											requestId: crypto.randomUUID(),
											digest: pack.digest,
											expectedRevision: pack.revision,
										},
									})
								}
							>
								{l["toolPacks.uninstall"]}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={disabled || archived || !model || pack.status !== "enabled" || !capacity.live}
								onClick={() => choose({ kind: "live", pack })}
							>
								{l["toolPacks.bind"]}
							</Button>
						</div>
					</article>
				))}
				<div className="flex gap-2">
					<Button variant="ghost" disabled={state.busy} onClick={() => void session.pagePacks()}>
						{l["toolPacks.first"]}
					</Button>
					<Button
						variant="ghost"
						disabled={state.busy || !state.packCursor}
						onClick={() => {
							if (state.packCursor) void session.pagePacks(state.packCursor);
						}}
					>
						{l["toolPacks.next"]}
					</Button>
				</div>
			</section>
			{conversation && (
				<section className="grid gap-2 border-t border-border pt-3 text-sm">
					<div className="flex flex-wrap gap-2">
						<Button
							variant="ghost"
							disabled={state.busy}
							aria-pressed={!state.history}
							onClick={() => void session.pageBindings(false)}
						>
							{l["toolPacks.active"]}
						</Button>
						<Button
							variant="ghost"
							disabled={state.busy}
							aria-pressed={state.history}
							onClick={() => void session.pageBindings(true)}
						>
							{l["toolPacks.history"]}
						</Button>
					</div>
					<p>{l["toolPacks.capacity"]}</p>
					{state.loaded && !state.bindings.length && <p>{l["toolPacks.noBindings"]}</p>}
					{state.bindings.map((binding) => (
						<article key={binding.bindingId} className="grid gap-2 rounded-md border border-border p-3">
							<p className="font-medium">
								{l[binding.purpose === "live-package" ? "toolPacks.live" : "toolPacks.retained"]}
							</p>
							<p className="break-all">{binding.digest}</p>
							<p>
								{binding.model.provider} / {binding.model.modelId}
							</p>
							<p>
								{
									l[
										`toolPacks.status.${binding.status === "active" && binding.expiresAt <= Date.now() ? "expired" : binding.status}`
									]
								}{" "}
								· {l["toolPacks.expires"]}: {date(binding.expiresAt)}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={state.busy}
									onClick={() => {
										setTarget(null);
										void session.source(binding.digest);
									}}
								>
									{l["toolPacks.source"]}
								</Button>
								{binding.purpose === "live-package" && (
									<Button
										size="sm"
										variant="outline"
										disabled={disabled || archived || !model || !binding.disclosed || !capacity.retained}
										onClick={() => choose({ kind: "retained", binding })}
									>
										{l["toolPacks.retain"]}
									</Button>
								)}
								<Button
									size="sm"
									variant="outline"
									disabled={disabled || binding.status !== "active" || binding.expiresAt <= Date.now()}
									onClick={() =>
										void session.execute({
											version: PROTOCOL_VERSION,
											method: "revokeToolPackBinding",
											params: {
												workspaceId,
												conversationId: conversation.conversationId,
												requestId: crypto.randomUUID(),
												bindingId: binding.bindingId,
												expectedRevision: binding.revision,
											},
										})
									}
								>
									{l["toolPacks.revoke"]}
								</Button>
							</div>
						</article>
					))}
					{state.history && (
						<div className="flex gap-2">
							<Button variant="ghost" disabled={state.busy} onClick={() => void session.pageBindings(true)}>
								{l["toolPacks.first"]}
							</Button>
							<Button
								variant="ghost"
								disabled={state.busy || !state.bindingCursor}
								onClick={() => {
									if (state.bindingCursor) void session.pageBindings(true, state.bindingCursor);
								}}
							>
								{l["toolPacks.next"]}
							</Button>
						</div>
					)}
				</section>
			)}
			{modelQuery.isError && <p role="alert">{l["toolPacks.failed"]}</p>}
			{!model && <p>{l["toolPacks.noModel"]}</p>}
			{state.source && <ToolPackSource locale={locale} {...state.source} />}
			{target && conversation && model && (
				<section className="grid gap-3 border-t border-border pt-3 text-sm">
					<h3 className="font-medium">{l[target.kind === "live" ? "toolPacks.bind" : "toolPacks.retain"]}</h3>
					<p>{l[target.kind === "live" ? "toolPacks.disclosure" : "toolPacks.retainedDisclosure"]}</p>
					<p className="break-all">
						{l["toolPacks.scope"]}: {workspaceId} / {conversation.conversationId}
					</p>
					<p>
						{l["toolPacks.model"]}: {model.provider} / {model.modelId}
					</p>
					<p className="break-all">
						{l["toolPacks.digest"]}: {digest}
					</p>
					<Select
						value={duration}
						onValueChange={(value) => {
							setDuration(value);
							setConfirmed(false);
						}}
					>
						<SelectTrigger aria-label={l["toolPacks.expiry"]}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="900000">{l["toolPacks.short"]}</SelectItem>
							<SelectItem value="3600000">{l["toolPacks.long"]}</SelectItem>
						</SelectContent>
					</Select>
					{!sourceReady && <p>{l["toolPacks.sourceNeeded"]}</p>}
					<label htmlFor={confirmationId} className="flex items-start gap-2">
						<input
							id={confirmationId}
							type="checkbox"
							className="mt-1 accent-primary focus-visible:outline-ring"
							checked={confirmed}
							disabled={!sourceReady || disabled || archived}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						{l["toolPacks.confirm"]}
					</label>
					<Button
						disabled={
							disabled ||
							archived ||
							!sourceReady ||
							!confirmed ||
							(target.kind === "live" ? !capacity.live : !capacity.retained)
						}
						onClick={() => {
							if (!conversation || !model || !sourceReady || !confirmed || archived) return;
							const common = bindingRequest(
								{ workspaceId, conversationId: conversation.conversationId },
								model,
								Number(duration),
							);
							const command =
								target.kind === "live"
									? session.execute({
											version: PROTOCOL_VERSION,
											method: "bindToolPack",
											params: { ...common, digest: target.pack.digest, expectedPackRevision: target.pack.revision },
										})
									: session.execute({
											version: PROTOCOL_VERSION,
											method: "authorizeRetainedToolPack",
											params: { ...common, sourceBindingId: target.binding.bindingId },
										});
							void command.then(() => {
								if (!session.getSnapshot().failed && !session.getSnapshot().pending) {
									setTarget(null);
									setConfirmed(false);
								}
							});
						}}
					>
						{l[target.kind === "live" ? "toolPacks.bind" : "toolPacks.retain"]}
					</Button>
				</section>
			)}
		</div>,
	);
}
