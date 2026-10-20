import { AppError, type CustomProviderConfiguration, type ModelCatalog } from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppClient, useCredentialClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { CustomProviderEditor } from "./custom-provider-editor.tsx";
import { providerLabels } from "./provider-labels.ts";
import "./custom-provider-settings.css";

export function CustomProviderSettings({ enabled, catalog }: { enabled: boolean; catalog?: ModelCatalog }) {
	const client = useAppClient();
	const credentials = useCredentialClient();
	const cache = useQueryClient();
	const { locale, t } = usePreferences();
	const l = providerLabels(locale);
	const [editor, setEditor] = useState<{ initial?: CustomProviderConfiguration }>();
	const [removal, setRemoval] = useState<CustomProviderConfiguration>();
	const [busy, setBusy] = useState(false);
	const [removeState, setRemoveState] = useState<"keyRemovalUnconfirmed" | "keyRemovedRemoveUnconfirmed">();
	const [notice, setNotice] = useState(false);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const addButton = useRef<HTMLButtonElement | null>(null);
	const heading = useRef<HTMLHeadingElement | null>(null);
	const active = useRef(true);
	const removing = useRef(false);
	const removeRequest = useRef<string | undefined>(undefined);
	const profiles = useQuery({
		queryKey: ["custom-providers"],
		queryFn: ({ signal }) => client.call("listCustomProviders", {}, signal),
		enabled,
		retry: false,
	});
	const restoreFocus = () => {
		if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
		else if (addButton.current && !addButton.current.disabled) addButton.current.focus();
		else heading.current?.focus();
	};
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const remove = async () => {
		if (!removal || removing.current) return;
		removing.current = true;
		setBusy(true);
		let keyRemoved = false;
		try {
			if (!credentials) throw new AppError("CLOSED");
			await credentials.request({ operation: "remove", provider: removal.provider });
			keyRemoved = true;
			removeRequest.current ??= crypto.randomUUID();
			await client.call("removeCustomProvider", {
				provider: removal.provider,
				requestId: removeRequest.current,
			});
			if (active.current) {
				setNotice(true);
				setRemoval(undefined);
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
			if (active.current) setBusy(false);
		}
	};
	return (
		<section className="custom-provider-settings" data-setting="custom-providers">
			<div className="settings-section-heading">
				<h3 ref={heading} tabIndex={-1}>
					{l["provider.title"]}
				</h3>
				<div className="custom-provider-actions">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={profiles.isFetching}
						onClick={() => void profiles.refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						{l["provider.refresh"]}
					</Button>
					<Button
						ref={addButton}
						type="button"
						size="sm"
						variant="outline"
						disabled={profiles.isPending || profiles.isError || (profiles.data?.providers.length ?? 0) >= 16}
						onClick={(event) => {
							trigger.current = event.currentTarget;
							setNotice(false);
							setEditor({});
						}}
					>
						<Plus size={14} aria-hidden="true" />
						{l["provider.add"]}
					</Button>
				</div>
			</div>
			{profiles.isPending && enabled && <output className="settings-hint">{l["provider.loading"]}</output>}
			{profiles.isError && (
				<p role="alert" className="settings-notice">
					{l["provider.loadFailed"]}
				</p>
			)}
			{profiles.data?.providers.length === 0 && <p className="settings-empty">{l["provider.empty"]}</p>}
			<div className="settings-card">
				{profiles.data?.providers.map((provider) => {
					const status = catalog?.providers.find((item) => item.provider === provider.provider)?.credentialState;
					return (
						<div key={provider.provider} className="custom-provider-row">
							<div className="settings-row-copy">
								<strong>{provider.name}</strong>
								<span>{l[provider.protocol === "openai-completions" ? "provider.openai" : "provider.anthropic"]}</span>
								<span>{provider.baseUrl}</span>
								<output className="custom-provider-hint">
									{status ? t(`model.${status}`) : l["provider.statusUnknown"]}
								</output>
							</div>
							<div className="custom-provider-actions">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={profiles.isError}
									onClick={(event) => {
										trigger.current = event.currentTarget;
										setNotice(false);
										setEditor({ initial: provider });
									}}
								>
									{l["provider.edit"]}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={profiles.isError}
									onClick={(event) => {
										trigger.current = event.currentTarget;
										setRemoveState(undefined);
										removeRequest.current = undefined;
										setRemoval(provider);
									}}
								>
									{l["provider.remove"]}
								</Button>
							</div>
						</div>
					);
				})}
			</div>
			{notice && <output className="settings-feedback">{l["provider.removed"]}</output>}
			<Dialog
				open={editor !== undefined}
				onOpenChange={(open) => {
					if (!open && !busy) setEditor(undefined);
				}}
			>
				<DialogContent
					scrollBody
					className="custom-provider-dialog"
					closeLabel={l["provider.close"]}
					closeDisabled={busy}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						restoreFocus();
					}}
				>
					<DialogTitle>{l[editor?.initial ? "provider.editTitle" : "provider.add"]}</DialogTitle>
					{editor && <CustomProviderEditor initial={editor.initial} onBusy={setBusy} />}
				</DialogContent>
			</Dialog>
			<Dialog
				open={removal !== undefined}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoval(undefined);
				}}
			>
				<DialogContent
					closeLabel={l["provider.close"]}
					closeDisabled={busy}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						restoreFocus();
					}}
				>
					<DialogTitle>{l["provider.removeTitle"]}</DialogTitle>
					<DialogDescription>{l["provider.removeNote"]}</DialogDescription>
					<strong>{removal?.name}</strong>
					{removeState && <p role="alert">{l[`provider.${removeState}`]}</p>}
					<div className="custom-provider-actions">
						<Button variant="outline" disabled={busy} onClick={() => setRemoval(undefined)}>
							{l["provider.cancel"]}
						</Button>
						<Button disabled={busy} onClick={() => void remove()}>
							{l["provider.remove"]}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}
