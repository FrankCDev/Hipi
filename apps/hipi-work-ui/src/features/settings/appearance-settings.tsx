import { type AppearanceClient, AppearanceError, type AppearanceStatus } from "@hipi/work-runtime/appearance";
import { Check, Copy, Download, LoaderCircle, Upload } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useAppearance } from "../../app/appearance-provider.tsx";
import { codeThemeChoices } from "../../app/theme/code-theme-catalog.ts";
import {
	type AppearanceMode,
	type ConfigError,
	defaultAppearance,
	defaultConfig,
	fontSizeBounds,
	fonts,
	parseAppearanceShare,
	type ThemeConfig,
	useThemeSettings,
} from "../../app/theme/index.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { type FontCatalogQuery, type FontCatalogState, nativeFontCatalog } from "./font-catalog-query.ts";
import { settingsLabels } from "./labels.ts";
import { settingsPageLabels } from "./settings-page-labels.ts";
import { SettingsSurface } from "./settings-surface.tsx";
import "./settings-page.css";

/** Connection screens have no AppClient; the same modal exposes only device appearance. */
export function AppearanceSettings() {
	const theme = useThemeSettings();
	const t = settingsLabels(theme.config.locale);
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	return (
		<>
			<Button
				ref={trigger}
				variant="ghost"
				size="sm"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(true)}
			>
				{t("settings.title")}
			</Button>
			<SettingsSurface
				open={open}
				onOpenChange={setOpen}
				title={t("settings.title")}
				closeLabel={settingsPageLabels(theme.config.locale)["settingsPage.close"]}
				initialFocus={heading}
				onRestoreFocus={() => trigger.current?.focus()}
			>
				<section className="settings-page-content settings-standalone">
					<div className="settings-page-content-inner">
						<h2 ref={heading} tabIndex={-1} className="settings-page-heading">
							{t("settings.general")}
						</h2>
						<GeneralSettings />
						<h2 className="settings-standalone-appearance">{t("settings.appearance")}</h2>
						<SettingsForm />
					</div>
				</section>
			</SettingsSurface>
		</>
	);
}

function SettingRow({
	label,
	description,
	settingId,
	children,
}: {
	label: string;
	description?: string;
	settingId: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<div className="settings-control-row" data-setting={settingId}>
			<div className="settings-choice-copy">
				<span id={id}>{label}</span>
				{description && <p>{description}</p>}
			</div>
			<fieldset className="settings-row-control" aria-labelledby={id}>
				{children}
			</fieldset>
		</div>
	);
}

function Choice({
	label,
	value,
	options,
	onChange,
	onOpenChange,
	loading,
	notice,
	action,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	loading?: string;
	notice?: ReactNode;
	action?: { value: string; label: string; onSelect: () => void };
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (action && next === action.value) action.onSelect();
				else onChange(next);
			}}
			onOpenChange={onOpenChange}
		>
			<SelectTrigger aria-label={label} aria-busy={!!loading} className="settings-choice" size="sm">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{loading && (
					<output className="settings-hint" data-font-status="pending">
						<LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
						{loading}
					</output>
				)}
				{notice && <div className="max-w-72 whitespace-normal px-2">{notice}</div>}
				{options.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
				{action && <SelectItem value={action.value}>{action.label}</SelectItem>}
			</SelectContent>
		</Select>
	);
}

/** Local editing ends at this control. Invalid input never enters the persisted theme. */
function CommittedInput({
	value,
	label,
	onCommit,
	type = "text",
	sizeKind,
	placeholder,
}: {
	value: string;
	label: string;
	onCommit: (value: string) => boolean;
	type?: "text" | "number";
	sizeKind?: "ui" | "code";
	placeholder?: string;
}) {
	const [draft, setDraft] = useState(value);
	const beforePointer = useRef<string | undefined>(undefined);
	useEffect(() => setDraft(value), [value]);
	const commit = (text: string) => {
		if (text === value) return;
		if (onCommit(text)) setDraft(type === "number" ? String(Number(text)) : text.trim());
		else setDraft(value);
	};
	return (
		<Input
			aria-label={label}
			type={type}
			className={type === "number" ? "settings-size-input" : "settings-text-input"}
			value={draft}
			placeholder={placeholder}
			min={sizeKind ? fontSizeBounds[sizeKind].min : undefined}
			max={sizeKind ? fontSizeBounds[sizeKind].max : undefined}
			step={sizeKind ? fontSizeBounds[sizeKind].step : undefined}
			maxLength={type === "text" ? 128 : undefined}
			spellCheck={false}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={(event) => commit(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					commit(event.currentTarget.value);
				}
			}}
			onPointerDown={(event) => {
				beforePointer.current = event.currentTarget.value;
			}}
			onPointerUp={(event) => {
				if (
					type === "number" &&
					beforePointer.current !== undefined &&
					beforePointer.current !== event.currentTarget.value
				)
					commit(event.currentTarget.value);
				beforePointer.current = undefined;
			}}
		/>
	);
}

export function GeneralSettings() {
	const theme = useThemeSettings();
	const config = theme.config;
	const t = settingsLabels(config.locale);
	const update = theme.update;
	return (
		<div className="settings-form">
			<div className="settings-control-group">
				<SettingRow settingId="language" label={t("settings.locale")}>
					<Choice
						label={t("settings.locale")}
						value={config.locale}
						options={[
							{ value: "zh-CN", label: "简体中文" },
							{ value: "en", label: "English" },
						]}
						onChange={(locale) => {
							if (locale === "en" || locale === "zh-CN") update({ ...config, locale });
						}}
					/>
				</SettingRow>
			</div>
			{theme.status !== "available" && (
				<output className="settings-notice">
					{t(theme.status === "memory" ? "settings.memory" : "settings.invalid")}
				</output>
			)}
		</div>
	);
}

export function SettingsForm({ selectedSetting }: { selectedSetting?: string } = {}) {
	const theme = useThemeSettings();
	const native = useAppearance();
	const config = theme.config;
	const t = settingsLabels(config.locale);
	const [error, setError] = useState<ConfigError>();
	const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "imported" | "downloadFailed">();
	const [importOpen, setImportOpen] = useState(false);
	const [share, setShare] = useState("");
	const [copying, setCopying] = useState(false);
	const [separateModes, setSeparateModes] = useState(false);
	const [openedFontPicker, setOpenedFontPicker] = useState<{
		client: AppearanceClient;
		platform?: AppearanceStatus["platform"];
	}>();
	const fontClient = native.client;
	const fontPlatform = native.status?.platform;
	const browserFontAccess = fontPlatform === "web" || !fontClient;
	const query = nativeFontCatalog(native.client, native.status?.platform);
	const fontOwner = query ?? native.client;
	const [fontState, setFontState] = useState<{ owner?: AppearanceClient | FontCatalogQuery; state: FontCatalogState }>({
		state: { status: "idle" },
	});
	const currentFontState = fontState.owner === fontOwner ? fontState.state : ({ status: "idle" } as const);
	const catalog = currentFontState.status === "ready" ? currentFontState.catalog : undefined;
	const fontError = currentFontState.status === "error" ? currentFontState.error : undefined;
	const loadingFonts = currentFontState.status === "pending";
	const fontRequest = useRef<AbortController | undefined>(undefined);
	const [customEditing, setCustomEditing] = useState<{ uiFont: boolean; contentFont: boolean; codeFont: boolean }>({
		uiFont: !!config.customUiFont,
		contentFont: !!config.customContentFont,
		codeFont: !!config.customCodeFont,
	});
	const [systemDark, setSystemDark] = useState(
		() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
	);
	const importTrigger = useRef<HTMLButtonElement>(null);
	const alive = useRef(true);
	const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(() => {
		alive.current = true;
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		const update = () => setSystemDark(media?.matches ?? false);
		media?.addEventListener("change", update);
		return () => {
			alive.current = false;
			fontRequest.current?.abort();
			fontRequest.current = undefined;
			media?.removeEventListener("change", update);
			for (const [url, timer] of downloads.current) {
				clearTimeout(timer);
				URL.revokeObjectURL(url);
			}
			downloads.current.clear();
		};
	}, []);
	useEffect(() => {
		if (!query || !openedFontPicker || openedFontPicker.client !== fontClient) return;
		if (openedFontPicker.platform !== undefined && openedFontPicker.platform !== fontPlatform) return;
		// A picker opened while status was pending belongs only to the first resolved platform.
		if (openedFontPicker.platform === undefined && fontClient)
			setOpenedFontPicker({ client: fontClient, platform: fontPlatform });
		return query.subscribe((state) => setFontState({ owner: query, state }));
	}, [query, openedFontPicker, fontClient, fontPlatform]);
	useEffect(() => {
		if (!native.client) return;
		return () => {
			fontRequest.current?.abort();
			fontRequest.current = undefined;
		};
	}, [native.client]);
	const update = (next: ThemeConfig) => {
		const result = theme.update(next);
		setError(result.ok ? undefined : result.error);
		setFeedback(undefined);
		return result.ok;
	};
	const activeMode: AppearanceMode = config.mode === "system" ? (systemDark ? "dark" : "light") : config.mode;
	const showSeparateModes =
		separateModes || /^(light|dark)-(accent|background|foreground)$/.test(selectedSetting ?? "");
	const modes: AppearanceMode[] = showSeparateModes ? ["light", "dark"] : [activeMode];
	const defaults = defaultConfig();
	const hasAdvancedChanges =
		separateModes ||
		config.contentFont !== defaults.contentFont ||
		config.codeFont !== defaults.codeFont ||
		!!config.customContentFont ||
		!!config.customCodeFont ||
		config.uiFontSize !== defaults.uiFontSize ||
		config.codeFontSize !== defaults.codeFontSize ||
		config.reducedMotion !== defaults.reducedMotion ||
		config.codeTheme !== defaults.codeTheme ||
		config.pointerCursor !== defaults.pointerCursor ||
		config.fontSmoothing !== defaults.fontSmoothing ||
		!!config.localFontFaces.content ||
		!!config.localFontFaces.code ||
		Object.keys(config.regions).length > 0;
	const imported = share.trim() ? parseAppearanceShare(share.trim()) : undefined;
	const copy = async () => {
		setCopying(true);
		try {
			await navigator.clipboard.writeText(theme.export());
			if (alive.current) setFeedback("copied");
		} catch {
			if (alive.current) setFeedback("copyFailed");
		} finally {
			if (alive.current) setCopying(false);
		}
	};
	const downloadOriginal = () => {
		if (theme.original === undefined) return;
		let url: string | undefined;
		try {
			url = URL.createObjectURL(new Blob([theme.original], { type: "application/json" }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "hipi-rejected-settings.json";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
		} catch {
			setFeedback("downloadFailed");
		} finally {
			if (url) {
				const owned = url;
				downloads.current.set(
					owned,
					setTimeout(() => {
						URL.revokeObjectURL(owned);
						downloads.current.delete(owned);
					}, 1000),
				);
			}
		}
	};
	const fontOptions = [
		...Object.keys(fonts).map((font) => ({ value: font, label: t(`settings.font.${font as keyof typeof fonts}`) })),
		{ value: "custom", label: t("settings.font.custom") },
	];
	const openFontPicker = (open: boolean) => {
		if (open && fontClient) setOpenedFontPicker({ client: fontClient, platform: fontPlatform });
	};
	const fontNotice = !browserFontAccess &&
		(fontError ||
			catalog?.truncated ||
			catalog?.families.length === 0 ||
			fontClient?.localFontsSupported === false) && (
			<>
				{fontError && (
					<p role="alert" className="settings-hint">
						{t(`settings.native.${fontError}`)}
					</p>
				)}
				{catalog?.truncated && <p className="settings-hint">{t("settings.fontsLimited")}</p>}
				{catalog && catalog.families.length === 0 && <p className="settings-hint">{t("settings.fontsEmpty")}</p>}
				{fontClient && !fontClient.localFontsSupported && (
					<p className="settings-hint">{t("settings.fontsUnsupported")}</p>
				)}
			</>
		);
	const fontRetry =
		query && fontError
			? { value: "retry-font-catalog", label: t("settings.fontsRetry"), onSelect: () => query.retry() }
			: undefined;
	const fontControl = (field: "uiFont" | "contentFont" | "codeFont") => {
		const area = field === "uiFont" ? "ui" : field === "contentFont" ? "content" : "code";
		const face = config.localFontFaces[area];
		const families = catalog?.families.filter((family) => field !== "codeFont" || family.monospace) ?? [];
		const selectedFamily = families.find((family) => family.family === face?.family);
		const customField =
			field === "uiFont" ? "customUiFont" : field === "contentFont" ? "customContentFont" : "customCodeFont";
		const custom = !face && (customEditing[field] || !!config[customField]);
		const choices = [
			...(field === "contentFont" ? [{ value: "inherit", label: t("settings.font.inherit") }] : []),
			...fontOptions,
			...families.map((family) => ({ value: `installed:${family.family}`, label: family.family })),
			...(face && !selectedFamily ? [{ value: `installed:${face.family}`, label: face.family }] : []),
		];
		return (
			<div
				className="settings-font-control"
				data-setting={!browserFontAccess && field === "uiFont" ? "installedFonts" : undefined}
			>
				<Choice
					label={t(`settings.${field}`)}
					value={face ? `installed:${face.family}` : custom ? "custom" : config[field]}
					options={choices}
					onOpenChange={openFontPicker}
					loading={loadingFonts ? t("settings.fontsLoading") : undefined}
					notice={fontNotice}
					action={fontRetry}
					onChange={(value) => {
						const localFontFaces = { ...config.localFontFaces };
						delete localFontFaces[area];
						const installed = families.find((family) => `installed:${family.family}` === value);
						if (installed?.faces[0]) {
							localFontFaces[area] = installed.faces[0];
							const next = { ...config, localFontFaces };
							delete next[customField];
							update(next);
							return;
						}
						if (value === "custom") {
							if (face) update({ ...config, localFontFaces });
							setCustomEditing((current) => ({ ...current, [field]: true }));
							return;
						}
						if (
							(value === "inherit" && field === "contentFont") ||
							value === "system" ||
							value === "serif" ||
							value === "mono"
						) {
							const next = { ...config, [field]: value, localFontFaces };
							delete next[customField];
							if (update(next)) setCustomEditing((current) => ({ ...current, [field]: false }));
						}
					}}
				/>
				{face && (
					<Choice
						label={t(`settings.${field}Style`)}
						value={face.postscriptName}
						options={(selectedFamily?.faces ?? [face]).map((item) => ({
							value: item.postscriptName,
							label: item.style,
						}))}
						onOpenChange={openFontPicker}
						loading={loadingFonts ? t("settings.fontsLoading") : undefined}
						notice={fontNotice}
						action={fontRetry}
						onChange={(value) => {
							const selected = selectedFamily?.faces.find((item) => item.postscriptName === value);
							if (selected) update({ ...config, localFontFaces: { ...config.localFontFaces, [area]: selected } });
						}}
					/>
				)}
				{custom && (
					<CommittedInput
						label={t(
							field === "uiFont"
								? "settings.font.family"
								: field === "contentFont"
									? "settings.font.contentFamily"
									: "settings.font.codeFamily",
						)}
						value={config[customField] ?? ""}
						placeholder={t("settings.font.family")}
						onCommit={(value) => {
							const next = { ...config };
							if (value.trim()) next[customField] = value.trim();
							else delete next[customField];
							return update(next);
						}}
					/>
				)}
			</div>
		);
	};
	return (
		<div className="settings-form">
			{theme.status !== "available" && (
				<output className="settings-notice">
					{t(theme.status === "memory" ? "settings.memory" : "settings.invalid")}
				</output>
			)}
			<h3 className="settings-visual-heading">{t("settings.visual")}</h3>
			<div className="settings-control-group settings-mode-group">
				<SettingRow settingId="theme" label={t("settings.mode")}>
					<TooltipProvider>
						<div className="settings-theme-options" role="radiogroup" aria-label={t("settings.theme")}>
							{(["system", "light", "dark"] as const).map((mode) => (
								<Tooltip key={mode}>
									<TooltipTrigger asChild>
										<label key={mode} className="settings-theme-option" data-mode={mode}>
											<input
												aria-label={t(`settings.${mode}`)}
												type="radio"
												name="appearance-theme"
												value={mode}
												checked={config.mode === mode}
												onChange={() => update({ ...config, mode })}
											/>
											<span className="settings-theme-preview" aria-hidden="true">
												<span />
												<span>
													<i />
													<i />
													<i />
												</span>
											</span>
											<span className="sr-only">{t(`settings.${mode}`)}</span>
										</label>
									</TooltipTrigger>
									<TooltipContent>{t(`settings.${mode}`)}</TooltipContent>
								</Tooltip>
							))}
						</div>
					</TooltipProvider>
				</SettingRow>
			</div>
			<div className="settings-control-group settings-palette-group">
				<div className="settings-section-heading settings-appearance-heading">
					<h3>{t("settings.theme")}</h3>
					<div className="settings-theme-actions">
						<Button
							ref={importTrigger}
							data-setting="transfer"
							variant="ghost"
							size="icon"
							aria-label={t("settings.importTheme")}
							onClick={() => setImportOpen(true)}
						>
							<Download size={16} aria-hidden="true" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("settings.copy")}
							data-setting="copyTheme"
							disabled={copying}
							onClick={() => void copy()}
						>
							{feedback === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
						</Button>
					</div>
				</div>
				{modes.map((mode) => {
					const colors = config.appearance[mode] ?? defaultAppearance(mode);
					return (
						<section className="settings-appearance-card" key={mode} aria-label={t(`settings.${mode}`)}>
							{showSeparateModes && <h4>{t(`settings.${mode}`)}</h4>}
							{(["accent", "background", "foreground"] as const).map((field) => (
								<SettingRow key={field} settingId={`${mode}-${field}`} label={t(`settings.${field}`)}>
									<label className="settings-color-control">
										<span className="sr-only">
											{t(`settings.${mode}`)} {t(`settings.${field}`)}
										</span>
										<input
											type="color"
											aria-label={`${t(`settings.${mode}`)} ${t(`settings.${field}`)}`}
											value={colors[field]}
											onChange={(event) => {
												if (
													!update({
														...config,
														appearance: { ...config.appearance, [mode]: { ...colors, [field]: event.target.value } },
													})
												)
													event.currentTarget.value = colors[field];
											}}
										/>
										<span aria-hidden="true">{colors[field].toUpperCase()}</span>
									</label>
								</SettingRow>
							))}
						</section>
					);
				})}
				<SettingRow settingId="uiFont" label={t("settings.uiFont")}>
					{fontControl("uiFont")}
				</SettingRow>
				{browserFontAccess && (
					<SettingRow
						settingId="installedFonts"
						label={t("settings.installedFonts")}
						description={t("settings.fontAccessDescription")}
					>
						{native.client?.localFontsSupported ? (
							<Button
								variant="ghost"
								size="sm"
								disabled={loadingFonts}
								onClick={() => {
									if (!native.client || fontRequest.current) return;
									const client = native.client;
									const controller = new AbortController();
									fontRequest.current = controller;
									setFontState({ owner: client, state: { status: "pending" } });
									void client
										.listFonts(controller.signal)
										.then(
											(value) => {
												if (!controller.signal.aborted && fontRequest.current === controller)
													setFontState({ owner: client, state: { status: "ready", catalog: value } });
											},
											(error: unknown) => {
												if (!controller.signal.aborted && fontRequest.current === controller)
													setFontState({
														owner: client,
														state: { status: "error", error: error instanceof AppearanceError ? error.code : "FAILED" },
													});
											},
										)
										.finally(() => {
											if (fontRequest.current === controller) fontRequest.current = undefined;
										});
								}}
							>
								{t(
									loadingFonts
										? "settings.fontsLoading"
										: fontError
											? "settings.fontsRetry"
											: catalog
												? "settings.fontsRefresh"
												: "settings.fontsLoad",
								)}
							</Button>
						) : (
							<span className="settings-hint">{t("settings.fontsUnsupported")}</span>
						)}
					</SettingRow>
				)}
				{(query || currentFontState.status !== "idle") && (
					<output
						className="sr-only"
						aria-live="polite"
						data-font-catalog-state={currentFontState.status}
						data-font-family-count={catalog?.families.length}
						data-font-error={fontError}
						data-font-catalog-truncated={catalog?.truncated}
					>
						{loadingFonts
							? t("settings.fontsLoading")
							: catalog
								? `${t("settings.installedFonts")}: ${catalog.families.length}`
								: ""}
					</output>
				)}
				{browserFontAccess && catalog?.truncated && <p className="settings-hint">{t("settings.fontsLimited")}</p>}
				{browserFontAccess && catalog && catalog.families.length === 0 && (
					<p className="settings-hint">{t("settings.fontsEmpty")}</p>
				)}
				{browserFontAccess && fontError && (
					<p role="alert" className="error-text">
						{t(`settings.native.${fontError}`)}
					</p>
				)}
				{native.status && native.status.backdrop !== "unsupported" && (
					<SettingRow
						settingId="translucentSidebar"
						label={t("settings.translucentSidebar")}
						description={
							native.status.reducedTransparency
								? t("settings.reducedTransparency")
								: native.contrastOpaque
									? t("settings.backdropContrast")
									: undefined
						}
					>
						<input
							type="checkbox"
							role="switch"
							className="settings-toggle"
							aria-label={t("settings.translucentSidebar")}
							aria-checked={config.translucentSidebar}
							checked={config.translucentSidebar}
							disabled={native.status.reducedTransparency}
							onChange={(event) => update({ ...config, translucentSidebar: event.target.checked })}
						/>
					</SettingRow>
				)}
				{native.error && (
					<p role="alert" className="error-text">
						{t(`settings.native.${native.error}`)}
					</p>
				)}
				{config.translucentSidebar && native.status?.backdrop === "unsupported" && (
					<p className="settings-hint">{t("settings.backdropUnsupported")}</p>
				)}
			</div>
			<div className="settings-advanced-wrap">
				<details className="settings-advanced" data-setting="advanced">
					<summary>{t("settings.advanced")}</summary>
					<div className="settings-advanced-body">
						<div className="settings-control-group">
							<SettingRow
								settingId="uiFontSize"
								label={t("settings.uiFontSize")}
								description={t("settings.uiFontSizeDescription")}
							>
								<CommittedInput
									type="number"
									sizeKind="ui"
									label={t("settings.uiFontSize")}
									value={String(config.uiFontSize)}
									onCommit={(value) => update({ ...config, uiFontSize: value.trim() ? Number(value) : Number.NaN })}
								/>
								<span className="settings-unit">px</span>
							</SettingRow>
							<SettingRow
								settingId="codeFontSize"
								label={t("settings.codeFontSize")}
								description={t("settings.codeFontSizeDescription")}
							>
								<CommittedInput
									type="number"
									sizeKind="code"
									label={t("settings.codeFontSize")}
									value={String(config.codeFontSize)}
									onCommit={(value) => update({ ...config, codeFontSize: value.trim() ? Number(value) : Number.NaN })}
								/>
								<span className="settings-unit">px</span>
							</SettingRow>
						</div>
						<div className="settings-control-group">
							<SettingRow settingId="separateModes" label={t("settings.separateModes")}>
								<input
									type="checkbox"
									role="switch"
									aria-checked={separateModes}
									className="settings-toggle"
									aria-label={t("settings.separateModes")}
									checked={separateModes}
									onChange={(event) => setSeparateModes(event.target.checked)}
								/>
							</SettingRow>
						</div>
						<div className="settings-control-group">
							<SettingRow settingId="contentFont" label={t("settings.contentFont")}>
								{fontControl("contentFont")}
							</SettingRow>
							<SettingRow settingId="codeFont" label={t("settings.codeFont")}>
								{fontControl("codeFont")}
							</SettingRow>
							<SettingRow settingId="codeTheme" label={t("settings.codeTheme")}>
								<Choice
									label={t("settings.codeTheme")}
									value={config.codeTheme}
									options={codeThemeChoices.map((value) => ({ value, label: t(`settings.codeTheme.${value}`) }))}
									onChange={(value) => {
										const choice = codeThemeChoices.find((item) => item === value);
										if (choice) update({ ...config, codeTheme: choice });
									}}
								/>
							</SettingRow>
							{native.status?.fontSmoothing && (
								<SettingRow settingId="fontSmoothing" label={t("settings.fontSmoothing")}>
									<Choice
										label={t("settings.fontSmoothing")}
										value={config.fontSmoothing}
										options={["system", "antialiased"].map((value) => ({
											value,
											label: t(value === "system" ? "settings.system" : "settings.smoothingAntialiased"),
										}))}
										onChange={(value) => {
											if (value === "system" || value === "antialiased") update({ ...config, fontSmoothing: value });
										}}
									/>
								</SettingRow>
							)}
							<SettingRow settingId="pointerCursor" label={t("settings.pointerCursor")}>
								<input
									type="checkbox"
									role="switch"
									className="settings-toggle"
									aria-label={t("settings.pointerCursor")}
									aria-checked={config.pointerCursor}
									checked={config.pointerCursor}
									onChange={(event) => update({ ...config, pointerCursor: event.target.checked })}
								/>
							</SettingRow>
						</div>
						<p className="settings-hint">{t("settings.font.note")}</p>
						<p className="settings-hint">{t("settings.colorsDescription")}</p>
						<div className="settings-control-group">
							<SettingRow
								settingId="reducedMotion"
								label={t("settings.reducedMotion")}
								description={t("settings.reducedMotionDescription")}
							>
								<Choice
									label={t("settings.reducedMotion")}
									value={config.reducedMotion}
									options={(["system", "on", "off"] as const).map((value) => ({
										value,
										label: t(`settings.${value}`),
									}))}
									onChange={(reducedMotion) => {
										if (reducedMotion === "system" || reducedMotion === "on" || reducedMotion === "off")
											update({ ...config, reducedMotion });
									}}
								/>
							</SettingRow>
						</div>
						<div className="settings-transfer-actions">
							{theme.original !== undefined && (
								<Button variant="outline" onClick={downloadOriginal}>
									<Upload size={14} aria-hidden="true" />
									{t("settings.exportOriginal")}
								</Button>
							)}
						</div>
					</div>
				</details>
				{hasAdvancedChanges && (
					<Button
						className="settings-advanced-reset"
						variant="ghost"
						onClick={() => {
							const next = {
								...config,
								contentFont: defaults.contentFont,
								codeFont: defaults.codeFont,
								uiFontSize: defaults.uiFontSize,
								codeFontSize: defaults.codeFontSize,
								reducedMotion: defaults.reducedMotion,
								codeTheme: defaults.codeTheme,
								pointerCursor: defaults.pointerCursor,
								fontSmoothing: defaults.fontSmoothing,
								localFontFaces: { ...config.localFontFaces, content: undefined, code: undefined },
								regions: {},
							};
							delete next.customContentFont;
							delete next.customCodeFont;
							if (update(next)) {
								setSeparateModes(false);
								setCustomEditing((current) => ({ ...current, contentFont: false, codeFont: false }));
							}
						}}
					>
						{t("settings.reset")}
					</Button>
				)}
			</div>
			{error && (
				<p role="alert" className="settings-feedback error-text">
					{t(`settings.error.${error}`)}
				</p>
			)}
			{feedback && (
				<output className="settings-feedback" aria-live="polite">
					{t(`settings.${feedback}`)}
				</output>
			)}
			<Dialog
				open={importOpen}
				onOpenChange={(open) => {
					setImportOpen(open);
					if (!open) setShare("");
				}}
			>
				<DialogContent
					className="settings-import-dialog"
					closeLabel={t("settings.cancel")}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						importTrigger.current?.focus();
					}}
				>
					<DialogTitle>{t("settings.importTheme")}</DialogTitle>
					<DialogDescription>{t("settings.importDescription")}</DialogDescription>
					<Textarea
						aria-label={t("settings.shareString")}
						rows={4}
						value={share}
						maxLength={24000}
						spellCheck={false}
						onChange={(event) => setShare(event.target.value)}
					/>
					{imported && !imported.ok && (
						<p role="alert" className="error-text">
							{t(`settings.error.${imported.error}`)}
						</p>
					)}
					<div className="settings-import-actions">
						<Button
							variant="outline"
							onClick={() => {
								setImportOpen(false);
								setShare("");
							}}
						>
							{t("settings.cancel")}
						</Button>
						<Button
							disabled={!imported?.ok}
							onClick={() => {
								if (imported?.ok && update({ ...imported.value, locale: config.locale })) {
									setImportOpen(false);
									setShare("");
									setCustomEditing({
										uiFont: !!imported.value.customUiFont,
										contentFont: !!imported.value.customContentFont,
										codeFont: !!imported.value.customCodeFont,
									});
									setFeedback("imported");
								}
							}}
						>
							{t("settings.import")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
