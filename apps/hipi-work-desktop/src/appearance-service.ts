import {
	AppearanceError,
	type AppearanceRequest,
	type AppearanceStatus,
	type AppearanceThemeMode,
} from "@hipi/work-runtime/appearance";

export interface AppearanceWindow {
	isDestroyed(): boolean;
	setVibrancy(value: "sidebar" | null): void;
	setBackgroundMaterial(value: "mica" | "none"): void;
	setBackgroundColor(value: string): void;
}
export interface AppearanceNativeTheme {
	themeSource: AppearanceThemeMode;
}
export function backdropSupport(platform: string, release: string): AppearanceStatus["backdrop"] {
	if (platform === "darwin") return "vibrancy";
	const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release);
	// Electron's Windows backdrop API requires Windows 11 22H2 (build 22621).
	if (platform === "win32" && version && Number(version[1]) >= 10 && Number(version[3]) >= 22621) return "mica";
	return "unsupported";
}
/** Owns window material and the app's theme override, never the OS appearance/accessibility settings. */
export class WindowAppearanceService {
	readonly #window: AppearanceWindow;
	readonly #platform: string;
	readonly #backdrop: AppearanceStatus["backdrop"];
	readonly #reduced: () => boolean;
	readonly #theme: AppearanceNativeTheme;
	#requested = false;
	#enabled = false;
	#background = "#ffffff";
	constructor(
		window: AppearanceWindow,
		platform: string,
		release: string,
		reduced: () => boolean,
		theme: AppearanceNativeTheme,
	) {
		this.#window = window;
		this.#platform = platform;
		this.#backdrop = backdropSupport(platform, release);
		this.#reduced = reduced;
		this.#theme = theme;
	}
	status(): AppearanceStatus {
		if (this.#window.isDestroyed()) throw new AppearanceError("CLOSED");
		return {
			version: 1,
			platform:
				this.#platform === "darwin"
					? "macos"
					: this.#platform === "win32"
						? "windows"
						: this.#platform === "linux"
							? "linux"
							: "other",
			backdrop: this.#backdrop,
			reducedTransparency: this.#reduced(),
			backdropEnabled: this.#enabled && !this.#reduced(),
			fontSmoothing: this.#platform === "darwin",
			themeMode: this.#theme.themeSource,
		};
	}
	request(request: AppearanceRequest): AppearanceStatus {
		if (request.method === "status") return this.status();
		this.status();
		if (request.method === "theme") {
			try {
				// The setter emits native updates. A status notification must not write it again.
				if (this.#theme.themeSource !== request.mode) this.#theme.themeSource = request.mode;
			} catch {
				throw new AppearanceError("FAILED");
			}
			return this.status();
		}
		if (request.enabled && this.#backdrop === "unsupported") throw new AppearanceError("UNSUPPORTED");
		this.#requested = request.enabled;
		this.#background = request.background;
		return this.refresh();
	}
	refresh(): AppearanceStatus {
		this.status();
		const enabled = this.#requested && !this.#reduced() && this.#backdrop !== "unsupported";
		try {
			if (this.#backdrop === "vibrancy") this.#window.setVibrancy(enabled ? "sidebar" : null);
			if (this.#backdrop === "mica") this.#window.setBackgroundMaterial(enabled ? "mica" : "none");
			this.#window.setBackgroundColor(enabled ? "#00000000" : this.#background);
			this.#enabled = enabled;
		} catch {
			this.#enabled = false;
			throw new AppearanceError("FAILED");
		}
		return this.status();
	}
	reset() {
		this.#requested = false;
		if (!this.#window.isDestroyed()) this.refresh();
	}
}
