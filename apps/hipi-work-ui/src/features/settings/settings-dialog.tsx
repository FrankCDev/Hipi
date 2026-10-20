import type { Conversation, ModelCatalog, Workspace } from "@hipi/work-runtime/contracts";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
	ArrowUpRight,
	ChevronRight,
	Cpu,
	Database,
	Folder,
	KeyRound,
	Palette,
	RefreshCw,
	Search,
	ShieldCheck,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useAppClient, useCredentialClient, useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { useThemeSettings } from "../../app/theme/index.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { SettingsForm } from "./appearance-settings.tsx";
import { settingsLabels } from "./labels.ts";
import { settingsPageLabels } from "./settings-page-labels.ts";
import { type SettingsCategory, searchSettings, settingsSearchEntries } from "./settings-search.ts";
import "./settings-page.css";

export type SettingsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestoreFocus?: () => void;
	workspace?: Workspace;
	conversation?: Conversation;
	credentialSettings: ReactNode;
	runtimeActions: ReactNode;
	workspaceActions?: ReactNode;
	onOpenFiles?: () => void;
	onOpenConversation?: () => void;
};

const categories = [
	{ id: "appearance", icon: Palette },
	{ id: "models", icon: Cpu },
	{ id: "runtime", icon: Database },
] as const;

/** Composition receives existing commands as slots; settings never chooses a host or broadens an authorization. */
export function SettingsDialog({ open, onOpenChange, onRestoreFocus, ...actions }: SettingsDialogProps) {
	const client = useAppClient();
	const theme = useThemeSettings();
	const { locale } = usePreferences();
	const l = settingsPageLabels(locale);
	const [category, setCategory] = useState<SettingsCategory>("appearance");
	const [query, setQuery] = useState("");
	const searching = query.trim().length > 0;
	const [dirty, setDirty] = useState(false);
	const [revision, setRevision] = useState(0);
	const [pending, setPending] = useState<{ category: SettingsCategory; target?: string } | "close" | null>(null);
	const [destination, setDestination] = useState<{ category: SettingsCategory; target?: string }>();
	const heading = useRef<HTMLHeadingElement>(null);
	const content = useRef<HTMLElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const restoreGuardFocus = useRef(true);
	const scrollPositions = useRef<Record<SettingsCategory, number>>({ appearance: 0, models: 0, runtime: 0 });
	const titleId = useId();
	const contentId = useId();
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
		enabled: open && (category === "models" || searching),
		retry: false,
	});
	const results = searching ? searchSettings(settingsSearchEntries(theme.config, catalog.data), query) : [];
	const navigate = (next: { category: SettingsCategory; target?: string } | "close") => {
		if (next === "close") {
			setQuery("");
			onOpenChange(false);
			return;
		}
		setCategory(next.category);
		setQuery("");
		setDestination(next);
	};
	const requestNavigation = (next: { category: SettingsCategory; target?: string } | "close") => {
		if (!searching && content.current) scrollPositions.current[category] = content.current.scrollTop;
		if (dirty && (next === "close" || next.category !== category)) {
			returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			restoreGuardFocus.current = true;
			setPending(next);
		} else navigate(next);
	};
	useEffect(() => {
		if (!open) {
			setDirty(false);
			setPending(null);
			setQuery("");
			setDestination(undefined);
		}
	}, [open]);
	useEffect(() => {
		const pane = content.current;
		if (!pane || !open) return;
		if (searching) {
			pane.scrollTop = 0;
			return;
		}
		const target = destination?.target;
		const row = target
			? Array.from(pane.querySelectorAll<HTMLElement>("[data-setting]")).find((node) => node.dataset.setting === target)
			: undefined;
		if (row) {
			if (row instanceof HTMLDetailsElement) row.open = true;
			row.scrollIntoView({ block: "center" });
			const control = row.querySelector<HTMLElement>("summary, button, input, textarea");
			if (control) control.focus({ preventScroll: true });
			else {
				row.tabIndex = -1;
				row.focus({ preventScroll: true });
			}
		} else {
			pane.scrollTop = scrollPositions.current[category];
			if (destination) heading.current?.focus({ preventScroll: true });
		}
	}, [open, category, searching, destination]);
	return (
		<Dialog open={open} onOpenChange={(value) => (value ? onOpenChange(true) : requestNavigation("close"))}>
			{open && (
				<DialogContent
					scrollBody
					className="unified-settings-dialog"
					closeLabel={l["settingsPage.close"]}
					aria-describedby={undefined}
					onEscapeKeyDown={(event) => {
						if (event.isComposing) {
							event.preventDefault();
						} else if (query) {
							event.preventDefault();
							setQuery("");
							searchInput.current?.focus();
						}
					}}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						heading.current?.focus();
					}}
					onCloseAutoFocus={(event) => {
						if (onRestoreFocus) {
							event.preventDefault();
							onRestoreFocus();
						}
					}}
				>
					<DialogTitle className="sr-only">{l["settingsPage.title"]}</DialogTitle>
					<div className="settings-page-layout">
						<div className="settings-page-sidebar">
							<p className="settings-page-brand">{l["settingsPage.title"]}</p>
							<div className="settings-search">
								<Search size={16} aria-hidden="true" />
								<Input
									ref={searchInput}
									className="settings-search-input"
									type="search"
									value={query}
									maxLength={160}
									placeholder={l["settingsPage.search"]}
									aria-label={l["settingsPage.search"]}
									aria-controls={contentId}
									onChange={(event) => {
										if (!searching && content.current) scrollPositions.current[category] = content.current.scrollTop;
										setDestination(undefined);
										setQuery(event.target.value);
									}}
								/>
								{query && (
									<Button
										variant="ghost"
										size="icon"
										aria-label={l["settingsPage.clearSearch"]}
										onClick={() => {
											setQuery("");
											searchInput.current?.focus();
										}}
									>
										<X size={14} aria-hidden="true" />
									</Button>
								)}
							</div>
							<nav className="settings-page-nav" aria-label={l["settingsPage.navigation"]}>
								{categories.map(({ id, icon: Icon }) => (
									<Button
										key={id}
										variant="ghost"
										data-category={id}
										aria-current={category === id ? "page" : undefined}
										aria-controls={contentId}
										onClick={() => requestNavigation({ category: id })}
									>
										<Icon size={18} aria-hidden="true" />
										<span>{l[`settingsPage.${id}`]}</span>
										<ChevronRight size={14} className="settings-nav-chevron" aria-hidden="true" />
									</Button>
								))}
							</nav>
							<div className="settings-page-sidebar-footer">
								<span>Hipi Work</span>
								<p>{l["settingsPage.device"]}</p>
							</div>
						</div>
						<div className="settings-page-main" id={contentId}>
							<header className="settings-page-header">
								<h2 ref={heading} className="settings-page-heading" tabIndex={-1} id={titleId}>
									{searching ? l["settingsPage.searchResults"] : l[`settingsPage.${category}`]}
								</h2>
								<p>{searching ? l["settingsPage.searchDescription"] : l[`settingsPage.${category}Description`]}</p>
								{dirty && <output className="settings-preview-status">{l["settingsPage.previewStatus"]}</output>}
							</header>
							<section
								ref={content}
								className="settings-page-content"
								aria-labelledby={titleId}
								onScroll={(event) => {
									if (!searching) scrollPositions.current[category] = event.currentTarget.scrollTop;
								}}
							>
								{searching && (
									<div className="settings-search-results">
										{results.length === 0 ? (
											<output className="settings-search-empty">
												<Search size={24} aria-hidden="true" />
												<strong>{l["settingsPage.noResults"]}</strong>
												<span>{l["settingsPage.noResultsNote"]}</span>
											</output>
										) : (
											results.map((result) => (
												<Button
													key={result.id}
													variant="ghost"
													className="settings-search-result"
													data-setting={result.id}
													onClick={() => requestNavigation({ category: result.category, target: result.id })}
												>
													<span className="settings-row-copy">
														<span>{result.destination}</span>
														<strong>{result.label}</strong>
														<span>{result.description}</span>
													</span>
													{result.value && <span className="settings-search-value">{result.value}</span>}
													<ChevronRight size={16} aria-hidden="true" />
												</Button>
											))
										)}
									</div>
								)}
								<section
									hidden={searching || category !== "appearance"}
									className="settings-section"
									data-category="appearance"
								>
									<AppearanceContent revision={revision} onDirtyChange={setDirty} />
								</section>
								<section
									hidden={searching || category !== "models"}
									className="settings-section"
									data-category="models"
								>
									<ModelContent catalog={catalog} credentialSettings={actions.credentialSettings} />
								</section>
								<section
									hidden={searching || category !== "runtime"}
									className="settings-section"
									data-category="runtime"
								>
									<RuntimeContent {...actions} />
								</section>
							</section>
						</div>
					</div>
					<Dialog
						open={pending !== null}
						onOpenChange={(value) => {
							if (!value) setPending(null);
						}}
					>
						{pending !== null && (
							<DialogContent
								className="settings-unsaved-dialog"
								closeLabel={l["settingsPage.keepEditing"]}
								onCloseAutoFocus={(event) => {
									event.preventDefault();
									if (restoreGuardFocus.current && returnFocus.current?.isConnected) returnFocus.current.focus();
								}}
							>
								<DialogTitle>{l["settingsPage.unsavedTitle"]}</DialogTitle>
								<DialogDescription>{l["settingsPage.unsavedNote"]}</DialogDescription>
								<div className="settings-unsaved-actions">
									<Button variant="outline" onClick={() => setPending(null)}>
										{l["settingsPage.keepEditing"]}
									</Button>
									<Button
										onClick={() => {
											restoreGuardFocus.current = false;
											theme.cancel();
											setDirty(false);
											setRevision((value) => value + 1);
											setPending(null);
											navigate(pending);
										}}
									>
										{l["settingsPage.discard"]}
									</Button>
								</div>
							</DialogContent>
						)}
					</Dialog>
				</DialogContent>
			)}
		</Dialog>
	);
}

function AppearanceContent({ revision, onDirtyChange }: { revision: number; onDirtyChange: (dirty: boolean) => void }) {
	const theme = useThemeSettings();
	const t = settingsLabels(theme.config.locale);
	const l = settingsPageLabels(theme.config.locale);
	const [cancelRevision, setCancelRevision] = useState(0);
	const [outcome, setOutcome] = useState<"saved" | "cancelled" | null>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// Cancel replaces the form to clear invalid and unapplied input, including the focused button.
		if (cancelRevision > 0) cancelButton.current?.focus({ preventScroll: true });
	}, [cancelRevision]);
	return (
		<>
			{theme.status !== "available" && (
				<output className="settings-notice">
					{t(theme.status === "memory" ? "settings.memory" : "settings.invalid")}
				</output>
			)}
			<p className="settings-hint">{l["settingsPage.previewNote"]}</p>
			<SettingsForm
				key={`${revision}:${cancelRevision}`}
				cancelRef={cancelButton}
				onDirtyChange={onDirtyChange}
				onPreview={() => setOutcome(null)}
				onSave={() => {
					theme.save();
					setOutcome("saved");
				}}
				onCancel={() => {
					theme.cancel();
					setCancelRevision((value) => value + 1);
					setOutcome("cancelled");
				}}
			/>
			{outcome && (
				<output className="settings-feedback" aria-live="polite">
					{outcome === "cancelled"
						? l["settingsPage.cancelled"]
						: t(theme.status === "memory" ? "settings.memory" : "settings.saved")}
				</output>
			)}
		</>
	);
}

function ModelContent({
	catalog,
	credentialSettings,
}: {
	catalog: UseQueryResult<ModelCatalog>;
	credentialSettings: ReactNode;
}) {
	const credentials = useCredentialClient();
	const { locale, t } = usePreferences();
	const l = settingsPageLabels(locale);
	return (
		<>
			<div className="settings-section-heading" data-setting="providers">
				<h3>{l["settingsPage.providers"]}</h3>
				<Button variant="ghost" size="sm" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>
					<RefreshCw size={14} aria-hidden="true" />
					{l["settingsPage.refresh"]}
				</Button>
			</div>
			{catalog.isFetching && <output className="settings-hint">{l["settingsPage.catalogLoading"]}</output>}
			{catalog.isError && (
				<p role="alert" className="settings-notice">
					{t("model.failed")}
				</p>
			)}
			<div className="settings-card">
				{catalog.data?.providers.map((provider) => (
					<div className="settings-provider-row" data-setting={`provider:${provider.provider}`} key={provider.provider}>
						<span className="settings-symbol">
							<Cpu size={18} aria-hidden="true" />
						</span>
						<div className="settings-row-copy">
							<strong>{provider.name}</strong>
							<span>{provider.provider}</span>
						</div>
						<output
							className="settings-provider-status"
							data-state={catalog.isError ? "unknown" : provider.credentialState}
						>
							{catalog.isError && <span>{l["settingsPage.lastKnown"]} · </span>}
							{t(`model.${provider.credentialState}`)}
						</output>
					</div>
				))}
				{catalog.data?.providers.length === 0 && <p className="settings-empty">{l["settingsPage.providersEmpty"]}</p>}
			</div>
			<p className="settings-hint">{l["settingsPage.providerNote"]}</p>
			<h3>{l["settingsPage.credentials"]}</h3>
			<div className="settings-card" data-setting="credentials">
				<div className="settings-row">
					<span className="settings-symbol">
						<KeyRound size={18} aria-hidden="true" />
					</span>
					<div className="settings-row-copy">
						<strong>
							{
								l[
									credentials
										? credentials.storage === "memory"
											? "settingsPage.memoryStorage"
											: "settingsPage.systemStorage"
										: "settingsPage.noCredentials"
								]
							}
						</strong>
						<p>
							{t(
								credentials
									? credentials.storage === "memory"
										? "model.memoryNote"
										: "model.secretNote"
									: "model.noPort",
							)}
						</p>
					</div>
				</div>
				<div className="settings-card-actions">{credentialSettings}</div>
			</div>
			<p className="settings-hint">{l["settingsPage.credentialsNote"]}</p>
			<h3>{l["settingsPage.catalog"]}</h3>
			<div className="settings-card" data-setting="catalog">
				{catalog.data?.models.map((model) => (
					<div
						className="settings-row"
						data-setting={`model:${JSON.stringify([model.provider, model.modelId])}`}
						key={JSON.stringify([model.provider, model.modelId])}
					>
						<div className="settings-row-copy">
							<strong>{model.name}</strong>
							<span>{model.modelId}</span>
						</div>
						<span className="settings-model-provider">{model.provider}</span>
					</div>
				))}
				{catalog.data?.models.length === 0 && <p className="settings-empty">{l["settingsPage.catalogEmpty"]}</p>}
			</div>
			<p className="settings-hint">{l["settingsPage.catalogNote"]}</p>
		</>
	);
}

function RuntimeContent({
	workspace,
	conversation,
	runtimeActions,
	workspaceActions,
	onOpenFiles,
	onOpenConversation,
}: Omit<SettingsDialogProps, "open" | "onOpenChange" | "onRestoreFocus">) {
	const client = useAppClient();
	const { files } = useFiles();
	const { locale } = usePreferences();
	const l = settingsPageLabels(locale);
	const check = useQuery({
		queryKey: ["settings-runtime-check"],
		queryFn: ({ signal }) => client.call("handshake", {}, signal),
		enabled: false,
		retry: false,
	});
	return (
		<>
			<h3>{l["settingsPage.connection"]}</h3>
			<div className="settings-card" data-setting="connection">
				<div className="settings-row">
					<span className="settings-symbol">
						<ShieldCheck size={18} aria-hidden="true" />
					</span>
					<div className="settings-row-copy">
						<strong>{l["settingsPage.connectionCheck"]}</strong>
						<output aria-live="polite">
							{
								l[
									check.isFetching
										? "settingsPage.connectionChecking"
										: check.isError
											? "settingsPage.connectionFailed"
											: check.isSuccess
												? "settingsPage.connectionChecked"
												: "settingsPage.connectionNotChecked"
								]
							}
						</output>
					</div>
					<Button variant="outline" size="sm" disabled={check.isFetching} onClick={() => void check.refetch()}>
						<RefreshCw size={14} aria-hidden="true" />
						{l["settingsPage.checkConnection"]}
					</Button>
				</div>
				<div className="settings-card-actions settings-runtime-actions">{runtimeActions}</div>
			</div>
			<p className="settings-hint">{l["settingsPage.checkNote"]}</p>
			<p className="settings-notice">{l["settingsPage.connectionNote"]}</p>
			<h3>{l["settingsPage.storage"]}</h3>
			<div className="settings-card">
				{(["workData", "localData", "appearanceData"] as const).map((kind) => (
					<div className="settings-row" key={kind} data-setting={kind}>
						<div className="settings-row-copy">
							<strong>{l[`settingsPage.${kind}`]}</strong>
							<p>{l[`settingsPage.${kind}Note`]}</p>
						</div>
					</div>
				))}
			</div>
			<h3>{l["settingsPage.currentScope"]}</h3>
			{workspace ? (
				<div className="settings-card settings-scope-card" data-setting="currentScope">
					<div className="settings-row">
						<span className="settings-symbol">
							<Folder size={18} aria-hidden="true" />
						</span>
						<div className="settings-row-copy">
							<strong>{workspace.name}</strong>
							<p>{l["settingsPage.scopeNote"]}</p>
						</div>
					</div>
					<div className="settings-row">
						<div className="settings-row-copy">
							<strong>{l["settingsPage.files"]}</strong>
							<p>{l[files ? "settingsPage.filesAvailable" : "settingsPage.filesUnavailable"]}</p>
						</div>
						{files && onOpenFiles && (
							<Button variant="outline" size="sm" onClick={onOpenFiles}>
								{l["settingsPage.openFiles"]}
								<ArrowUpRight size={14} aria-hidden="true" />
							</Button>
						)}
					</div>
					{workspaceActions && <div className="settings-card-actions">{workspaceActions}</div>}
					<div className="settings-row">
						<div className="settings-row-copy">
							<strong>{l["settingsPage.currentConversation"]}</strong>
							<p>{conversation?.title ?? l["settingsPage.noConversation"]}</p>
							{conversation?.archivedAt != null && <p>{l["settingsPage.scopeArchive"]}</p>}
						</div>
						{conversation && onOpenConversation && (
							<Button variant="outline" size="sm" onClick={onOpenConversation}>
								{l["settingsPage.openConversation"]}
								<ArrowUpRight size={14} aria-hidden="true" />
							</Button>
						)}
					</div>
				</div>
			) : (
				<p className="settings-empty settings-card" data-setting="currentScope">
					{l["settingsPage.noWorkspace"]}
				</p>
			)}
		</>
	);
}
