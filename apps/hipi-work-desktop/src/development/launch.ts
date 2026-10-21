import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const DEVELOPMENT_ORIGIN = "http://127.0.0.1:5173";
export const DEVELOPMENT_READY = "HIPI_DESKTOP_DEVELOPMENT_READY";
export const DEVELOPMENT_QUIT = "HIPI_DESKTOP_DEVELOPMENT_QUIT";

interface DevelopmentApp {
	isPackaged: boolean;
	getPath(name: "appData" | "userData" | "sessionData" | "logs" | "crashDumps"): string;
	setPath(name: string, path: string): void;
}

/** Called only by the explicitly compiled development entry, before any profile lock or session. */
export function prepareDevelopment(app: DevelopmentApp, args: readonly string[], token: string | undefined) {
	if (app.isPackaged || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid desktop development launch");
	if (args.some((argument) => argument.startsWith("--smoke-data-root")))
		throw new Error("Development and smoke profiles cannot be combined");
	const root = join(realpathSync(app.getPath("appData")), "Hipi Work Development");
	for (const path of [root, ...["profile", "session", "logs", "crashes"].map((name) => join(root, name))]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		const stat = lstatSync(path);
		if (
			stat.isSymbolicLink() ||
			!stat.isDirectory() ||
			realpathSync(path) !== path ||
			(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
		)
			throw new Error("Unsafe desktop development profile");
	}
	const paths = {
		userData: join(root, "profile"),
		sessionData: join(root, "session"),
		logs: join(root, "logs"),
		crashDumps: join(root, "crashes"),
	};
	for (const name of Object.keys(paths) as (keyof typeof paths)[]) {
		app.setPath(name, paths[name]);
		if (app.getPath(name) !== paths[name]) throw new Error("Development profile override was not applied");
	}
	return { page: `${DEVELOPMENT_ORIGIN}/?desktop=${token}` };
}
