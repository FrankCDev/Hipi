import { useEffect, useId, useRef, useState } from "react";
import {
	type ConfigError,
	defaultConfig,
	fonts,
	parseConfig,
	type Region,
	regions,
	type ThemeConfig,
	useThemeSettings,
} from "../../app/theme/index.ts";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { settingsLabels } from "./labels.ts";

export function AppearanceSettings() {
	const theme = useThemeSettings();
	const t = settingsLabels(theme.config.locale);
	const [open, setOpen] = useState(false);
	const [saved, setSaved] = useState(false);
	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!value) theme.cancel();
					setOpen(value);
					setSaved(false);
				}}
			>
				<DialogTrigger asChild>
					<Button variant="ghost" size="sm">
						{t("settings.title")}
					</Button>
				</DialogTrigger>
				{open && (
					<DialogContent scrollBody closeLabel={t("settings.cancel")} className="settings-dialog">
						<DialogTitle>{t("settings.title")}</DialogTitle>
						<DialogBody>
							<DialogDescription>{t("settings.description")}</DialogDescription>
							<SettingsForm
								onSave={() => {
									theme.save();
									setSaved(true);
									setOpen(false);
								}}
								onCancel={() => {
									theme.cancel();
									setOpen(false);
								}}
							/>
						</DialogBody>
					</DialogContent>
				)}
			</Dialog>
			{(theme.status !== "available" || saved) && (
				<output className="settings-storage-status">
					{t(
						theme.status === "memory"
							? "settings.memory"
							: theme.status === "invalid"
								? "settings.invalid"
								: "settings.saved",
					)}
				</output>
			)}
		</>
	);
}

function Choice({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger id={id} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function SettingsForm({
	onSave,
	onCancel,
	onPreview,
}: {
	onSave: () => void;
	onCancel: () => void;
	onPreview?: () => void;
}) {
	const theme = useThemeSettings();
	useEffect(() => () => theme.cancel(), [theme.cancel]);
	const pendingFile = useRef(0);
	const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(
		() => () => {
			pendingFile.current += 1;
			for (const [url, timer] of downloads.current) {
				clearTimeout(timer);
				URL.revokeObjectURL(url);
			}
			downloads.current.clear();
		},
		[],
	);
	const [draft, setDraft] = useState(theme.config);
	const [error, setError] = useState<ConfigError>();
	const [json, setJson] = useState("");
	const [downloadFailed, setDownloadFailed] = useState(false);
	const jsonId = useId();
	const fileId = useId();
	const errorId = useId();
	const input = useRef<HTMLTextAreaElement>(null);
	const t = settingsLabels(theme.config.locale);
	const fontOptions = Object.keys(fonts).map((value) => ({
		value,
		label: t(`settings.font.${value as keyof typeof fonts}`),
	}));
	const preview = (value: ThemeConfig) => {
		pendingFile.current += 1;
		onPreview?.();
		setDraft(value);
		const parsed = theme.preview(value);
		setError(parsed.ok ? undefined : parsed.error);
	};
	const patchRegion = (region: Region, patch: Record<string, string>) => {
		const next = { ...draft.regions[region], ...patch };
		const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== ""));
		preview({ ...draft, regions: { ...draft.regions, [region]: cleaned } });
	};
	const download = (text: string, filename: string) => {
		pendingFile.current += 1;
		setJson(text);
		setDownloadFailed(false);
		let url: string | undefined;
		try {
			url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = filename;
			document.body.append(link);
			link.click();
			link.remove();
		} catch {
			setDownloadFailed(true);
			input.current?.focus();
		} finally {
			if (url) {
				const downloadUrl = url;
				downloads.current.set(
					downloadUrl,
					setTimeout(() => {
						URL.revokeObjectURL(downloadUrl);
						downloads.current.delete(downloadUrl);
					}, 1000),
				);
			}
		}
	};
	return (
		<div className="settings-form">
			<div className="settings-grid settings-preferences">
				<Choice
					label={t("settings.mode")}
					value={draft.mode}
					options={["light", "dark", "system"].map((value) => ({
						value,
						label: t(`settings.${value as "light" | "dark" | "system"}`),
					}))}
					onChange={(mode) => {
						if (mode === "light" || mode === "dark" || mode === "system") preview({ ...draft, mode });
					}}
				/>
				<Choice
					label={t("settings.locale")}
					value={draft.locale}
					options={[
						{ value: "zh-CN", label: "简体中文" },
						{ value: "en", label: "English" },
					]}
					onChange={(locale) => {
						if (locale === "en" || locale === "zh-CN") preview({ ...draft, locale });
					}}
				/>
				{(["uiFont", "codeFont"] as const).map((field) => (
					<Choice
						key={field}
						label={t(`settings.${field}`)}
						value={draft[field]}
						options={fontOptions}
						onChange={(value) => {
							if (value === "system" || value === "serif" || value === "mono") preview({ ...draft, [field]: value });
						}}
					/>
				))}
			</div>
			<details className="settings-advanced">
				<summary>
					{t("settings.regions")}
					<span>{t("settings.regionsDescription")}</span>
				</summary>
				<div className="settings-advanced-body">
					<p className="small-copy">{t("settings.colorNote")}</p>
					{regions.map((region) => (
						<fieldset className="settings-region" key={region}>
							<legend>{t(`settings.region.${region}`)}</legend>
							<Choice
								label={t("settings.uiFont")}
								value={draft.regions[region]?.font ?? "inherit"}
								options={[{ value: "inherit", label: t("settings.inherit") }, ...fontOptions]}
								onChange={(value) => patchRegion(region, { font: value === "inherit" ? "" : value })}
							/>
							<div className="settings-grid">
								{(["foreground", "background"] as const).map((field) => (
									<label key={field} className="field" htmlFor={`${jsonId}-${region}-${field}`}>
										{t(`settings.${field}`)}
										<Input
											id={`${jsonId}-${region}-${field}`}
											value={draft.regions[region]?.[field] ?? ""}
											placeholder="#RRGGBB"
											maxLength={7}
											spellCheck={false}
											aria-invalid={!!error}
											aria-describedby={error ? errorId : undefined}
											onChange={(event) => patchRegion(region, { [field]: event.target.value })}
										/>
									</label>
								))}
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									const overrides = { ...draft.regions };
									delete overrides[region];
									preview({ ...draft, regions: overrides });
								}}
							>
								{t("settings.region.reset")}
							</Button>
						</fieldset>
					))}
				</div>
			</details>
			{error && (
				<p role="alert" id={errorId} className="error-text">
					{t(`settings.error.${error}`)}
				</p>
			)}
			<details className="settings-advanced" open={theme.original !== undefined ? true : undefined}>
				<summary>
					{t("settings.transfer")}
					<span>{t("settings.transferDescription")}</span>
				</summary>
				<div className="settings-advanced-body">
					<div className="settings-actions">
						<Button variant="outline" onClick={() => preview(defaultConfig())}>
							{t("settings.reset")}
						</Button>
						<Button variant="outline" onClick={() => download(theme.export(), "hipi-work-settings.json")}>
							{t("settings.export")}
						</Button>
						{theme.original !== undefined && (
							<Button
								variant="outline"
								onClick={() => download(theme.original ?? "", "hipi-work-rejected-settings.json")}
							>
								{t("settings.exportOriginal")}
							</Button>
						)}
					</div>
					<label className="field" htmlFor={jsonId}>
						{t("settings.json")}
					</label>
					<label className="field" htmlFor={fileId}>
						{t("settings.importFile")}
					</label>
					<Input
						id={fileId}
						type="file"
						accept=".json,application/json"
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							const generation = ++pendingFile.current;
							if (!file) return;
							if (file.size > 16384) {
								setError("format");
								return;
							}
							void file
								.text()
								.then((text) => {
									if (generation !== pendingFile.current) return;
									setJson(text);
									const parsed = parseConfig(text);
									if (parsed.ok) preview(parsed.value);
									else setError(parsed.error);
								})
								.catch(() => {
									if (generation === pendingFile.current) setError("format");
								});
						}}
					/>
					<Textarea
						id={jsonId}
						ref={input}
						rows={5}
						value={json}
						maxLength={16384}
						spellCheck={false}
						onChange={(event) => {
							pendingFile.current += 1;
							setJson(event.target.value);
						}}
					/>
					{downloadFailed && <p role="alert">{t("settings.downloadFailed")}</p>}
					<Button
						variant="outline"
						onClick={() => {
							const parsed = parseConfig(json);
							if (parsed.ok) preview(parsed.value);
							else setError(parsed.error);
						}}
					>
						{t("settings.import")}
					</Button>
				</div>
			</details>
			<div className="settings-actions settings-savebar">
				<Button variant="outline" onClick={onCancel}>
					{t("settings.cancel")}
				</Button>
				<Button disabled={!!error} onClick={onSave}>
					{t("settings.save")}
				</Button>
			</div>
		</div>
	);
}
