import {
	AppError,
	type CustomProviderConfiguration,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
} from "@hipi/work-runtime/contracts";
import { credentialSecret } from "@hipi/work-runtime/credentials";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useAppClient, useCredentialClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { DialogBody, DialogDescription } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { providerLabels } from "./provider-labels.ts";
import { providerPresets } from "./provider-presets.ts";

type DraftModel = { rowId: string; id: string; name: string };
type Outcome =
	| "saved"
	| "savedMissingKey"
	| "saveUnconfirmed"
	| "keyUnconfirmed"
	| "keyRemovalUnconfirmed"
	| "keyRemovedSaveUnconfirmed"
	| "invalid";

/** The editor owns only an ephemeral draft. Secret writes bypass query caches and application requests. */
export function CustomProviderEditor({
	initial,
	onBusy,
}: {
	initial?: CustomProviderConfiguration;
	onBusy: (busy: boolean) => void;
}) {
	const client = useAppClient();
	const credentials = useCredentialClient();
	const cache = useQueryClient();
	const { locale, t } = usePreferences();
	const l = providerLabels(locale);
	const [baseline, setBaseline] = useState(initial);
	const [preset, setPreset] = useState(initial?.vendorId ?? "custom");
	const [name, setName] = useState(initial?.name ?? "");
	const [protocol, setProtocol] = useState<CustomProviderConfiguration["protocol"]>(
		initial?.protocol ?? "openai-completions",
	);
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [models, setModels] = useState<DraftModel[]>(() =>
		(initial?.models ?? [{ id: "", name: "" }]).map((model) => ({ ...model, rowId: crypto.randomUUID() })),
	);
	const [secret, setSecret] = useState("");
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<Outcome>();
	const active = useRef(true);
	const gate = useRef(false);
	const pending = useRef<Params<"saveCustomProvider"> | undefined>(undefined);
	const prefix = useId();
	const presetKnown = providerPresets.some((item) => item.id === preset);
	const suggestions = useQuery({
		queryKey: ["built-in-provider-models", preset],
		queryFn: ({ signal }) => client.call("getBuiltInProviderModels", { vendorId: preset }, signal),
		enabled: presetKnown,
		retry: false,
	});
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const recipientChanged =
		baseline !== undefined &&
		(baseline.protocol !== protocol || baseline.baseUrl.replace(/\/+$/, "") !== baseUrl.trim().replace(/\/+$/, ""));
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: ["custom-providers"] }),
			cache.invalidateQueries({ queryKey: ["models"] }),
			cache.invalidateQueries({ queryKey: ["conversation-model"] }),
		]);
	};
	const save = async () => {
		if (gate.current) return;
		gate.current = true;
		setBusy(true);
		onBusy(true);
		setOutcome(undefined);
		const key = secret;
		setSecret("");
		let saved: CustomProviderConfiguration | undefined;
		let removingOldKey = false;
		let oldKeyRemoved = false;
		try {
			if (key) credentialSecret(key);
			const input: Omit<Params<"saveCustomProvider">, "requestId"> = {
				...(baseline ? { provider: baseline.provider } : {}),
				vendorId: presetKnown ? preset : "custom",
				name: name.trim(),
				protocol,
				baseUrl: baseUrl.trim(),
				models: models.map((model) => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim() })),
			};
			// Validate and canonicalize before any credential deletion, not after a destructive partial step.
			const parsed = parseRequest({
				version: PROTOCOL_VERSION,
				method: "saveCustomProvider",
				params: { ...input, requestId: crypto.randomUUID() },
			});
			if (parsed.method !== "saveCustomProvider") throw new AppError("INVALID_REQUEST");
			let target = baseline;
			if (pending.current) {
				// A previous acknowledgement may have been lost. Resolve that exact command before
				// applying changed fields, otherwise an edited retry could create a duplicate profile.
				target = await client.call("saveCustomProvider", pending.current);
				pending.current = undefined;
				if (active.current) setBaseline(target);
				if (
					target.name === parsed.params.name &&
					target.vendorId === parsed.params.vendorId &&
					target.protocol === parsed.params.protocol &&
					target.baseUrl === parsed.params.baseUrl &&
					JSON.stringify(target.models) === JSON.stringify(parsed.params.models)
				)
					saved = target;
			}
			if (!saved) {
				if (target && (target.protocol !== parsed.params.protocol || target.baseUrl !== parsed.params.baseUrl)) {
					removingOldKey = true;
					if (!credentials) throw new AppError("CLOSED");
					await credentials.request({ operation: "remove", provider: target.provider });
					removingOldKey = false;
					oldKeyRemoved = true;
				}
				pending.current = { ...parsed.params, ...(target ? { provider: target.provider } : {}) };
				saved = await client.call("saveCustomProvider", pending.current);
				pending.current = undefined;
			}
			if (active.current) {
				setBaseline(saved);
				setBaseUrl(saved.baseUrl);
			}
			if (key && credentials) await credentials.request({ operation: "set", provider: saved.provider, secret: key });
			const state = credentials
				? await credentials.request({ operation: "status", provider: saved.provider })
				: "unavailable";
			if (active.current)
				setOutcome(state === "configured" ? "saved" : state === "missing" ? "savedMissingKey" : "keyUnconfirmed");
		} catch (error) {
			if (active.current)
				setOutcome(
					removingOldKey
						? "keyRemovalUnconfirmed"
						: oldKeyRemoved && !saved
							? "keyRemovedSaveUnconfirmed"
							: saved
								? "keyUnconfirmed"
								: error instanceof AppError && error.code === "INVALID_REQUEST"
									? "invalid"
									: "saveUnconfirmed",
				);
		} finally {
			await refresh().catch(() => undefined);
			gate.current = false;
			if (active.current) {
				setBusy(false);
				onBusy(false);
			}
		}
	};
	const matches = (suggestions.data?.models ?? []).filter((model) =>
		`${model.name} ${model.id}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
	);
	const addSuggestion = (model: { id: string; name: string }) => {
		if (models.some((item) => item.id === model.id)) return;
		setModels((current) => [
			...current.filter((item) => item.id.trim() || item.name.trim()),
			{ ...model, rowId: crypto.randomUUID() },
		]);
	};
	return (
		<DialogBody>
			<DialogDescription>{l["provider.noNetwork"]}</DialogDescription>
			<form
				className="custom-provider-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<fieldset disabled={busy} className="custom-provider-fields">
					<label className="field" htmlFor={`${prefix}-preset`}>
						{l["provider.preset"]}
						<Select
							value={presetKnown ? preset : "custom"}
							onValueChange={(value) => {
								setPreset(value);
								setFilter("");
								const selected = providerPresets.find((item) => item.id === value);
								if (selected) {
									setName(selected.name);
									setProtocol(selected.protocol);
									setBaseUrl(selected.baseUrl);
									setModels([{ rowId: crypto.randomUUID(), id: "", name: "" }]);
								}
							}}
						>
							<SelectTrigger id={`${prefix}-preset`} className="custom-provider-select">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="custom">{l["provider.custom"]}</SelectItem>
								{providerPresets.map((item) => (
									<SelectItem value={item.id} key={item.id}>
										{item.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
					<label className="field" htmlFor={`${prefix}-name`}>
						{l["provider.name"]}
						<Input
							id={`${prefix}-name`}
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={128}
							required
						/>
					</label>
					<label className="field" htmlFor={`${prefix}-protocol`}>
						{l["provider.protocol"]}
						<Select
							value={protocol}
							onValueChange={(value) => {
								if (value === "openai-completions" || value === "anthropic-messages") setProtocol(value);
							}}
						>
							<SelectTrigger id={`${prefix}-protocol`} className="custom-provider-select">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper">
								<SelectItem value="openai-completions">{l["provider.openai"]}</SelectItem>
								<SelectItem value="anthropic-messages">{l["provider.anthropic"]}</SelectItem>
							</SelectContent>
						</Select>
					</label>
					<label className="field" htmlFor={`${prefix}-url`}>
						{l["provider.url"]}
						<Input
							id={`${prefix}-url`}
							type="url"
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
							maxLength={2048}
							spellCheck={false}
							autoComplete="off"
							required
						/>
						<span className="custom-provider-hint">
							{l[protocol === "openai-completions" ? "provider.openaiUrl" : "provider.anthropicUrl"]}
						</span>
					</label>
					{baseUrl.trim().startsWith("http:") && <p className="custom-provider-warning">{l["provider.httpWarning"]}</p>}
					{recipientChanged && <p className="custom-provider-warning">{l["provider.changedRecipient"]}</p>}
					<label className="field" htmlFor={`${prefix}-key`}>
						{l["provider.key"]}
						<Input
							id={`${prefix}-key`}
							type="password"
							value={secret}
							onChange={(event) => setSecret(event.target.value)}
							maxLength={4096}
							placeholder={l["provider.keyPlaceholder"]}
							spellCheck={false}
							autoComplete="off"
							disabled={!credentials}
						/>
						<span className="custom-provider-hint">
							{l[baseline && !recipientChanged ? "provider.keepKey" : "provider.newKey"]}
						</span>
					</label>
					<p className="custom-provider-hint">
						{credentials
							? t(credentials.storage === "memory" ? "model.memoryNote" : "model.secretNote")
							: l["provider.noCredentials"]}
					</p>
					{presetKnown && (
						<details className="custom-provider-suggestions">
							<summary>{l["provider.suggestions"]}</summary>
							<p className="custom-provider-hint">{l["provider.suggestionsHint"]}</p>
							<Input
								type="search"
								aria-label={l["provider.modelSearch"]}
								placeholder={l["provider.modelSearch"]}
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
							/>
							{suggestions.isPending && <output>{t("common.loading")}</output>}
							{suggestions.isError && <p role="alert">{l["provider.suggestionsFailed"]}</p>}
							<div className="custom-provider-suggestion-list">
								{matches.slice(0, 50).map((model) => {
									const selected = models.some((item) => item.id === model.id);
									return (
										<Button
											key={model.id}
											type="button"
											variant="ghost"
											disabled={selected || models.filter((item) => item.id.trim()).length >= 16}
											onClick={() => addSuggestion(model)}
										>
											<span>
												<strong>{model.name}</strong>
												<span>{model.id}</span>
											</span>
											{selected ? <span>{l["provider.selected"]}</span> : <Plus size={15} aria-hidden="true" />}
										</Button>
									);
								})}
							</div>
							{!suggestions.isPending && matches.length === 0 && (
								<p className="custom-provider-hint">{l["provider.suggestionsEmpty"]}</p>
							)}
							{matches.length > 50 && <p className="custom-provider-hint">{l["provider.moreSuggestions"]}</p>}
						</details>
					)}
					<div className="custom-provider-models">
						<h3>{l["provider.models"]}</h3>
						<p className="custom-provider-hint">{l["provider.manual"]}</p>
						{models.map((model) => (
							<div className="custom-provider-model-row" key={model.rowId}>
								<label className="field" htmlFor={`${prefix}-${model.rowId}-id`}>
									{l["provider.modelId"]}
									<Input
										id={`${prefix}-${model.rowId}-id`}
										value={model.id}
										onChange={(event) =>
											setModels((current) =>
												current.map((item) =>
													item.rowId === model.rowId ? { ...item, id: event.target.value } : item,
												),
											)
										}
										maxLength={256}
										spellCheck={false}
										required
									/>
								</label>
								<label className="field" htmlFor={`${prefix}-${model.rowId}-name`}>
									{l["provider.modelName"]}
									<Input
										id={`${prefix}-${model.rowId}-name`}
										value={model.name}
										placeholder={model.id}
										onChange={(event) =>
											setModels((current) =>
												current.map((item) =>
													item.rowId === model.rowId ? { ...item, name: event.target.value } : item,
												),
											)
										}
										maxLength={256}
									/>
								</label>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={l["provider.removeModel"]}
									disabled={models.length <= 1}
									onClick={() => setModels((current) => current.filter((item) => item.rowId !== model.rowId))}
								>
									<X size={16} aria-hidden="true" />
								</Button>
							</div>
						))}
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={models.length >= 16}
							onClick={() => setModels((current) => [...current, { rowId: crypto.randomUUID(), id: "", name: "" }])}
						>
							<Plus size={15} aria-hidden="true" />
							{l["provider.addModel"]}
						</Button>
						{models.length >= 16 && <p className="custom-provider-hint">{l["provider.modelLimit"]}</p>}
					</div>
				</fieldset>
				{outcome && (
					<p role={outcome.startsWith("saved") ? "status" : "alert"} className="custom-provider-feedback">
						{l[`provider.${outcome}`]}
					</p>
				)}
				<Button type="submit" disabled={busy}>
					{l[busy ? "provider.saving" : "provider.save"]}
				</Button>
			</form>
		</DialogBody>
	);
}
