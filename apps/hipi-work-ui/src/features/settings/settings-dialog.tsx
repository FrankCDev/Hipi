import type { Conversation, Workspace } from "@hipi/work-runtime/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowUpRight,
	ChevronRight,
	Cpu,
	Database,
	Folder,
	Palette,
	RefreshCw,
	Search,
	Settings2,
	ShieldCheck,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useAppearance } from "../../app/appearance-provider.tsx";
import { useAppClient, useFiles } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { useThemeSettings } from "../../app/theme/index.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { GeneralSettings, SettingsForm } from "./appearance-settings.tsx";
import { ModelSettingsContent } from "./model-settings-content.tsx";
import { settingsPageLabels } from "./settings-page-labels.ts";
import { type SettingsCategory, searchSettings, settingsSearchEntries } from "./settings-search.ts";
import { SettingsSurface } from "./settings-surface.tsx";
import "./settings-page.css";

export type SettingsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestoreFocus?: () => void;
	initialCategory?: SettingsCategory;
	workspace?: Workspace;
	conversation?: Conversation;
	credentialSettings: ReactNode;
	runtimeActions: ReactNode;
	workspaceActions?: ReactNode;
	onOpenFiles?: () => void;
	onOpenConversation?: () => void;
};

const categories = [
	{ id: "general", icon: Settings2 },
	{ id: "appearance", icon: Palette },
	{ id: "models", icon: Cpu },
	{ id: "runtime", icon: Database },
] as const;

/** Settings owns presentation only. The work and protected mutation owners remain mounted. */
export function SettingsPage({ open, onOpenChange, onRestoreFocus, initialCategory, ...actions }: SettingsDialogProps) {
	const client = useAppClient();
	const theme = useThemeSettings();
	const appearance = useAppearance();
	const { locale } = usePreferences();
	const l = settingsPageLabels(locale);
	const [category, setCategory] = useState<SettingsCategory>(initialCategory ?? "general");
	const [query, setQuery] = useState("");
	const [highlighted, setHighlighted] = useState(-1);
	const [modelBusy, setModelBusy] = useState(false);
	const modelBusyRef = useRef(false);
	const changeModelBusy = useCallback((busy: boolean) => {
		modelBusyRef.current = busy;
		setModelBusy(busy);
	}, []);
	const searching = query.trim().length > 0;
	const [destination, setDestination] = useState<{ category: SettingsCategory; target?: string }>();
	const heading = useRef<HTMLHeadingElement>(null);
	const content = useRef<HTMLElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const wasOpen = useRef(false);
	const scrollPositions = useRef<Record<SettingsCategory, number>>({
		general: 0,
		appearance: 0,
		models: 0,
		runtime: 0,
	});
	const titleId = useId();
	const contentId = useId();
	const resultsId = useId();
	const catalog = useQuery({
		queryKey: ["models"],
		queryFn: ({ signal }) => client.call("listModels", {}, signal),
		enabled: open && (category === "models" || searching),
		retry: false,
	});
	const results = searching
		? searchSettings(settingsSearchEntries(theme.config, catalog.data, appearance.status), query)
		: [];
	const navigate = (next: { category: SettingsCategory; target?: string }) => {
		if (modelBusyRef.current) return;
		if (content.current) scrollPositions.current[category] = content.current.scrollTop;
		setCategory(next.category);
		setQuery("");
		setHighlighted(-1);
		setDestination(next);
	};
	useEffect(() => {
		if (open && !wasOpen.current) {
			if (initialCategory) setCategory(initialCategory);
		}
		if (!open && wasOpen.current) {
			setQuery("");
			setHighlighted(-1);
			setDestination(undefined);
		}
		wasOpen.current = open;
	}, [open, initialCategory]);
	useEffect(() => {
		const pane = content.current;
		if (!pane || !open) return;
		const target = destination?.target;
		const row = target
			? Array.from(pane.querySelectorAll<HTMLElement>("[data-setting]")).find((node) => node.dataset.setting === target)
			: undefined;
		if (row) {
			for (let parent = row.parentElement; parent && parent !== pane; parent = parent.parentElement) {
				if (parent instanceof HTMLDetailsElement) parent.open = true;
			}
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
	}, [open, category, destination]);
	return (
		<SettingsSurface
			open={open}
			onOpenChange={(next) => {
				if (next || !modelBusyRef.current) onOpenChange(next);
			}}
			busy={modelBusy}
			title={l["settingsPage.title"]}
			closeLabel={l["settingsPage.close"]}
			initialFocus={searchInput}
			onRestoreFocus={onRestoreFocus}
			onEscapeKeyDown={(event) => {
				if (!query) return;
				event.preventDefault();
				setQuery("");
				setHighlighted(-1);
				searchInput.current?.focus();
			}}
		>
			<div className="settings-page-layout">
				<aside className="settings-page-sidebar">
					<div className="settings-search">
						<Search size={16} aria-hidden="true" />
						<Input
							ref={searchInput}
							className="settings-search-input"
							type="search"
							value={query}
							maxLength={160}
							disabled={modelBusy}
							placeholder={l["settingsPage.searchPlaceholder"]}
							aria-label={l["settingsPage.search"]}
							aria-controls={searching ? resultsId : contentId}
							aria-activedescendant={searching && highlighted >= 0 ? `${resultsId}-${highlighted}` : undefined}
							onChange={(event) => {
								setQuery(event.target.value);
								setHighlighted(-1);
							}}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
								if (event.key === "Escape" && query) {
									event.preventDefault();
									event.stopPropagation();
									setQuery("");
									setHighlighted(-1);
								} else if (searching && results.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
									event.preventDefault();
									setHighlighted((index) =>
										event.key === "ArrowDown"
											? (index + 1) % results.length
											: index <= 0
												? results.length - 1
												: index - 1,
									);
								} else if (event.key === "Enter" && searching && highlighted >= 0) {
									const result = results[highlighted];
									if (result) {
										event.preventDefault();
										navigate({ category: result.category, target: result.target ?? result.id });
									}
								}
							}}
						/>
						{query && (
							<Button
								variant="ghost"
								size="icon"
								aria-label={l["settingsPage.clearSearch"]}
								disabled={modelBusy}
								onClick={() => {
									setQuery("");
									setHighlighted(-1);
									searchInput.current?.focus();
								}}
							>
								<X size={14} aria-hidden="true" />
							</Button>
						)}
					</div>
					{searching ? (
						<section id={resultsId} className="settings-search-results" aria-label={l["settingsPage.searchResults"]}>
							{results.length === 0 ? (
								<output className="settings-search-empty">
									<strong>{l["settingsPage.noResults"]}</strong>
								</output>
							) : (
								results.map((result, index) => (
									<Button
										key={result.id}
										id={`${resultsId}-${index}`}
										variant="ghost"
										className="settings-search-result"
										disabled={modelBusy}
										data-setting={result.id}
										data-highlighted={highlighted === index || undefined}
										onPointerMove={() => setHighlighted(index)}
										onFocus={() => setHighlighted(index)}
										onClick={() => navigate({ category: result.category, target: result.target ?? result.id })}
									>
										<span className="settings-row-copy">
											<strong>{result.label}</strong>
											<span>{result.destination}</span>
										</span>
										<ChevronRight size={14} aria-hidden="true" />
									</Button>
								))
							)}
						</section>
					) : (
						<nav className="settings-page-nav" aria-label={l["settingsPage.navigation"]}>
							{categories.map(({ id, icon: Icon }) => (
								<Button
									key={id}
									variant="ghost"
									disabled={modelBusy}
									data-category={id}
									aria-current={category === id ? "page" : undefined}
									aria-controls={contentId}
									onClick={() => navigate({ category: id })}
								>
									<Icon size={18} aria-hidden="true" />
									<span>{l[`settingsPage.${id}`]}</span>
								</Button>
							))}
						</nav>
					)}
				</aside>
				<div className="settings-page-main" id={contentId}>
					<section
						ref={content}
						className="settings-page-content"
						aria-labelledby={titleId}
						onScroll={(event) => {
							scrollPositions.current[category] = event.currentTarget.scrollTop;
						}}
					>
						<div className="settings-page-content-inner">
							<header className="settings-page-header">
								<h2 ref={heading} className="settings-page-heading" tabIndex={-1} id={titleId}>
									{l[`settingsPage.${category}`]}
								</h2>
							</header>
							<section hidden={category !== "general"} className="settings-section" data-category="general">
								<GeneralSettings />
							</section>
							<section hidden={category !== "appearance"} className="settings-section" data-category="appearance">
								<SettingsForm selectedSetting={destination?.target} />
							</section>
							<section hidden={category !== "models"} className="settings-section" data-category="models">
								<ModelSettingsContent enabled={category === "models"} catalog={catalog} onBusy={changeModelBusy} />
							</section>
							<section hidden={category !== "runtime"} className="settings-section" data-category="runtime">
								<RuntimeContent {...actions} />
							</section>
						</div>
					</section>
				</div>
			</div>
		</SettingsSurface>
	);
}

export const SettingsDialog = SettingsPage;

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
