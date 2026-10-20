import type { Conversation, Workspace } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowUpRight,
	ChevronRight,
	Cpu,
	Database,
	Folder,
	KeyRound,
	Palette,
	RefreshCw,
	ShieldCheck,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { useAppClient, useCredentialClient, useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { useThemeSettings } from "../../app/theme/index.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.tsx";
import { SettingsForm } from "./appearance-settings.tsx";
import { settingsLabels } from "./labels.ts";
import { settingsPageLabels } from "./settings-page-labels.ts";
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

type Category = "appearance" | "models" | "runtime";
const categories = [
	{ id: "appearance", icon: Palette },
	{ id: "models", icon: Cpu },
	{ id: "runtime", icon: Database },
] as const;

/** Composition receives existing commands as slots; settings never chooses a host or broadens an authorization. */
export function SettingsDialog({ open, onOpenChange, onRestoreFocus, ...actions }: SettingsDialogProps) {
	const { locale } = usePreferences();
	const l = settingsPageLabels(locale);
	const [category, setCategory] = useState<Category>("appearance");
	const heading = useRef<HTMLHeadingElement>(null);
	const content = useRef<HTMLElement>(null);
	const titleId = useId();
	const contentId = useId();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open && (
				<DialogContent
					scrollBody
					className="unified-settings-dialog"
					closeLabel={l["settingsPage.close"]}
					aria-describedby={undefined}
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
							<nav className="settings-page-nav" aria-label={l["settingsPage.navigation"]}>
								{categories.map(({ id, icon: Icon }) => (
									<Button
										key={id}
										variant="ghost"
										data-category={id}
										aria-current={category === id ? "page" : undefined}
										aria-controls={contentId}
										onClick={() => {
											if (category !== id && content.current) content.current.scrollTop = 0;
											setCategory(id);
										}}
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
								<h2 ref={heading} tabIndex={-1} id={titleId}>
									{l[`settingsPage.${category}`]}
								</h2>
								<p>{l[`settingsPage.${category}Description`]}</p>
							</header>
							<section ref={content} className="settings-page-content" aria-labelledby={titleId}>
								<section hidden={category !== "appearance"} className="settings-section" data-category="appearance">
									<AppearanceContent />
								</section>
								<section hidden={category !== "models"} className="settings-section" data-category="models">
									<ModelContent active={category === "models"} credentialSettings={actions.credentialSettings} />
								</section>
								<section hidden={category !== "runtime"} className="settings-section" data-category="runtime">
									<RuntimeContent {...actions} />
								</section>
							</section>
						</div>
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}

function AppearanceContent() {
	const theme = useThemeSettings();
	const t = settingsLabels(theme.config.locale);
	const l = settingsPageLabels(theme.config.locale);
	const [revision, setRevision] = useState(0);
	const [outcome, setOutcome] = useState<"saved" | "cancelled" | null>(null);
	return (
		<>
			{theme.status !== "available" && (
				<output className="settings-notice">
					{t(theme.status === "memory" ? "settings.memory" : "settings.invalid")}
				</output>
			)}
			<p className="settings-hint">{l["settingsPage.previewNote"]}</p>
			<SettingsForm
				key={revision}
				onPreview={() => setOutcome(null)}
				onSave={() => {
					theme.save();
					setOutcome("saved");
				}}
				onCancel={() => {
					theme.cancel();
					setRevision((value) => value + 1);
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

function ModelContent({ active, credentialSettings }: { active: boolean; credentialSettings: ReactNode }) {
	const client = useAppClient();
	const credentials = useCredentialClient();
	const { locale, t } = usePreferences();
	const l = settingsPageLabels(locale);
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
		enabled: active,
		retry: false,
	});
	return (
		<>
			<div className="settings-section-heading">
				<h3>{l["settingsPage.providers"]}</h3>
				<Button variant="ghost" size="sm" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>
					<RefreshCw size={14} aria-hidden="true" />
					{l["settingsPage.refresh"]}
				</Button>
			</div>
			{catalog.isFetching && <output className="settings-hint">{t("common.loading")}</output>}
			{catalog.isError && (
				<p role="alert" className="settings-notice">
					{t("model.failed")}
				</p>
			)}
			<div className="settings-card">
				{catalog.data?.providers.map((provider) => (
					<div className="settings-provider-row" key={provider.provider}>
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
			<div className="settings-card">
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
			<div className="settings-card">
				{catalog.data?.models.map((model) => (
					<div className="settings-row" key={JSON.stringify([model.provider, model.modelId])}>
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
			<div className="settings-card">
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
					<div className="settings-row" key={kind}>
						<div className="settings-row-copy">
							<strong>{l[`settingsPage.${kind}`]}</strong>
							<p>{l[`settingsPage.${kind}Note`]}</p>
						</div>
					</div>
				))}
			</div>
			<h3>{l["settingsPage.currentScope"]}</h3>
			{workspace ? (
				<div className="settings-card settings-scope-card">
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
				<p className="settings-empty settings-card">{l["settingsPage.noWorkspace"]}</p>
			)}
		</>
	);
}
