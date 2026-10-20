import { AppError, type CustomProviderConfiguration, type ModelCatalog } from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Cpu, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppClient, useCredentialClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CustomProviderEditor } from "./custom-provider-editor.tsx";
import { LegacyProviderEditor } from "./legacy-provider-editor.tsx";
import { providerLabels } from "./provider-labels.ts";
import "./custom-provider-settings.css";

type Editor = { kind: "custom"; initial?: CustomProviderConfiguration } | { kind: "openai" };

/** One list and one inline detail view. The outer Settings dialog owns focus trapping. */
export function CustomProviderSettings({
	enabled,
	catalog,
	catalogError = false,
	onRefresh,
	onBusy,
}: {
	enabled: boolean;
	catalog?: ModelCatalog;
	catalogError?: boolean;
	onRefresh?: () => void;
	onBusy?: (busy: boolean) => void;
}) {
	const client = useAppClient();
	const credentials = useCredentialClient();
	const cache = useQueryClient();
	const { locale } = usePreferences();
	const l = providerLabels(locale);
	const [editor, setEditor] = useState<Editor>();
	const [removal, setRemoval] = useState<CustomProviderConfiguration>();
	const [busy, setBusy] = useState(false);
	const [removeState, setRemoveState] = useState<"keyRemovalUnconfirmed" | "keyRemovedRemoveUnconfirmed">();
	const [notice, setNotice] = useState<"removed" | "saved" | "savedMissingKey">();
	const trigger = useRef<HTMLButtonElement | null>(null);
	const addButton = useRef<HTMLButtonElement | null>(null);
	const heading = useRef<HTMLHeadingElement | null>(null);
	const detail = useRef<HTMLElement | null>(null);
	const active = useRef(true);
	const busyGate = useRef(false);
	const removing = useRef(false);
	const removeRequest = useRef<string | undefined>(undefined);
	const profiles = useQuery({
		queryKey: ["custom-providers"],
		queryFn: ({ signal }) => client.call("listCustomProviders", {}, signal),
		enabled,
		retry: false,
	});
	const updateBusy = (value: boolean) => {
		busyGate.current = value;
		setBusy(value);
		onBusy?.(value);
	};
	const restoreFocus = () => {
		if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
		else if (addButton.current && !addButton.current.disabled) addButton.current.focus();
		else heading.current?.focus();
	};
	const back = () => {
		if (busyGate.current || removing.current) return;
		setEditor(undefined);
		setRemoval(undefined);
		requestAnimationFrame(restoreFocus);
	};
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const editorKind = editor?.kind;
	useEffect(() => {
		if (editorKind) {
			detail.current?.scrollIntoView({ block: "start" });
			detail.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
		}
	}, [editorKind]);
	const remove = async () => {
		if (!removal || removing.current) return;
		removing.current = true;
		updateBusy(true);
		let keyRemoved = false;
		let removed = false;
		try {
			if (!credentials) throw new AppError("CLOSED");
			await credentials.request({ operation: "remove", provider: removal.provider });
			keyRemoved = true;
			removeRequest.current ??= crypto.randomUUID();
			await client.call("removeCustomProvider", {
				provider: removal.provider,
				requestId: removeRequest.current,
			});
			removed = true;
			if (active.current) {
				setNotice("removed");
				setRemoval(undefined);
				setEditor(undefined);
			}
		} catch {
			if (active.current) setRemoveState(keyRemoved ? "keyRemovedRemoveUnconfirmed" : "keyRemovalUnconfirmed");
		} finally {
			await Promise.all([
				cache.invalidateQueries({ queryKey: ["custom-providers"] }),
				cache.invalidateQueries({ queryKey: ["models"] }),
				cache.invalidateQueries({ queryKey: ["conversation-model"] }),
			]).catch(() => undefined);
			removing.current = false;
			if (active.current) {
				updateBusy(false);
				if (removed) requestAnimationFrame(restoreFocus);
			}
		}
	};
	const customProfiles = profiles.data?.providers ?? [];
	const rows = [
		...(catalog?.providers.filter((provider) => !customProfiles.some((item) => item.provider === provider.provider)) ??
			[]),
		...customProfiles.map((profile) => ({
			provider: profile.provider,
			name: profile.name,
			credentialState: catalog?.providers.find((item) => item.provider === profile.provider)?.credentialState,
		})),
	];
	const failed = profiles.isError || catalogError;
	return (
		<section className="custom-provider-settings" data-setting="custom-providers">
			<div hidden={editor !== undefined} className="provider-list-view">
				<div className="settings-section-heading">
					<h3 ref={heading} tabIndex={-1}>
						{l["provider.title"]}
					</h3>
					<Button
						ref={addButton}
						type="button"
						size="sm"
						variant="outline"
						disabled={profiles.isPending || profiles.isError || customProfiles.length >= 16}
						onClick={(event) => {
							trigger.current = event.currentTarget;
							setNotice(undefined);
							setEditor({ kind: "custom" });
						}}
					>
						<Plus size={14} aria-hidden="true" />
						{l["provider.add"]}
					</Button>
				</div>
				{profiles.isPending && enabled && <output className="settings-hint">{l["provider.loading"]}</output>}
				{failed && (
					<div className="provider-list-error">
						<p role="alert">{l["provider.loadFailed"]}</p>
						<Button
							variant="outline"
							size="sm"
							disabled={profiles.isFetching}
							onClick={() => {
								void profiles.refetch();
								onRefresh?.();
							}}
						>
							{l["provider.refresh"]}
						</Button>
					</div>
				)}
				<div className="provider-service-list">
					{rows.map((provider) => {
						const profile = customProfiles.find((item) => item.provider === provider.provider);
						const editable = profile !== undefined || provider.provider === "openai";
						const count =
							profile?.models.length ??
							catalog?.models.filter((item) => item.provider === provider.provider).length ??
							0;
						const state = failed ? undefined : provider.credentialState;
						return (
							<Button
								key={provider.provider}
								type="button"
								variant="ghost"
								className="provider-service-row"
								data-setting={`provider:${provider.provider}`}
								disabled={!editable || (profile !== undefined && profiles.isError)}
								onClick={(event) => {
									trigger.current = event.currentTarget;
									setNotice(undefined);
									setEditor(profile ? { kind: "custom", initial: profile } : { kind: "openai" });
								}}
							>
								<span className="provider-service-icon">
									<Cpu size={18} aria-hidden="true" />
								</span>
								<span className="provider-service-copy">
									<strong>{provider.name}</strong>
									<span>
										{!profile && `${l["provider.builtIn"]} · `}
										{count} {l[count === 1 ? "provider.oneModel" : "provider.modelCount"]}
									</span>
								</span>
								<output className="provider-service-status" data-state={state ?? "unknown"}>
									{l[state ? (`provider.state.${state}` as const) : "provider.statusUnknown"]}
								</output>
								{editable && <ChevronRight size={16} aria-hidden="true" />}
							</Button>
						);
					})}
				</div>
				{rows.length === 0 && !profiles.isPending && !failed && <p className="settings-empty">{l["provider.empty"]}</p>}
				{notice && <output className="settings-feedback">{l[`provider.${notice}`]}</output>}
			</div>
			{editor && (
				<section ref={detail} className="provider-detail-view" data-provider-editor={editor.kind}>
					<header className="provider-detail-header">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							data-provider-back
							aria-label={l["provider.back"]}
							disabled={busy}
							onClick={back}
						>
							<ArrowLeft size={18} aria-hidden="true" />
						</Button>
						<h3>{editor.kind === "openai" ? "OpenAI" : (editor.initial?.name ?? l["provider.add"])}</h3>
					</header>
					{editor.kind === "openai" ? (
						<LegacyProviderEditor onBusy={updateBusy} />
					) : (
						<>
							<div hidden={removal !== undefined}>
								<CustomProviderEditor
									initial={editor.initial}
									onBusy={updateBusy}
									onSaved={(profile) => setEditor({ kind: "custom", initial: profile })}
									onDone={(state) => {
										setNotice(state === "configured" ? "saved" : "savedMissingKey");
										setEditor(undefined);
										requestAnimationFrame(restoreFocus);
									}}
								/>
								{editor.initial && (
									<Button
										type="button"
										variant="ghost"
										className="provider-remove-action"
										disabled={busy || !customProfiles.some((item) => item.provider === editor.initial?.provider)}
										onClick={() => {
											setRemoveState(undefined);
											removeRequest.current = undefined;
											setRemoval(editor.initial);
										}}
									>
										{l["provider.remove"]}
									</Button>
								)}
							</div>
							{removal && (
								<fieldset className="provider-remove-confirmation">
									<legend>{l["provider.removeTitle"]}</legend>
									<p>{l["provider.removeNote"]}</p>
									{removeState && <p role="alert">{l[`provider.${removeState}`]}</p>}
									<div className="custom-provider-actions">
										<Button variant="outline" disabled={busy} onClick={() => setRemoval(undefined)}>
											{l["provider.cancel"]}
										</Button>
										<Button disabled={busy} onClick={() => void remove()}>
											{l["provider.remove"]}
										</Button>
									</div>
								</fieldset>
							)}
						</>
					)}
				</section>
			)}
		</section>
	);
}
