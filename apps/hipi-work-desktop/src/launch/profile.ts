import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { providerMode } from "./provider-mode.ts";

type SmokePath = "userData" | "sessionData" | "logs" | "crashDumps";
interface LaunchApp {
	setPath(name: string, path: string): void;
	getPath(name: SmokePath): string;
	requestSingleInstanceLock(): boolean;
}

/** Path selection and single-instance ownership are one synchronous startup boundary. */
export function prepareDesktopLaunch(app: LaunchApp, arguments_: readonly string[]) {
	const mode = providerMode(arguments_);
	const paths = smokeProfile(arguments_, mode);
	if (paths) {
		for (const name of Object.keys(paths) as SmokePath[]) {
			app.setPath(name, paths[name]);
			if (app.getPath(name) !== paths[name]) throw new Error("Smoke profile override was not applied");
		}
	}
	return { mode, hasLock: app.requestSingleInstanceLock() };
}

/** A testing-only path override; never grants deletion authority or changes production defaults. */
export function smokeProfile(arguments_: readonly string[], mode: "production" | "deterministic") {
	const flags = arguments_.filter((value) => value === "--smoke-data-root" || value.startsWith("--smoke-data-root="));
	if (flags.length === 0) return undefined;
	if (mode !== "deterministic" || flags.length !== 1 || !flags[0].startsWith("--smoke-data-root="))
		throw new Error("Invalid deterministic smoke profile");
	const root = flags[0].slice("--smoke-data-root=".length);
	const temporary = realpathSync(tmpdir());
	if (
		!isAbsolute(root) ||
		resolve(root) !== root ||
		realpathSync(root) !== root ||
		dirname(root) !== temporary ||
		!/^Hipi GUI profile-[A-Za-z0-9]+$/.test(basename(root))
	)
		throw new Error("Smoke profile must be a canonical dedicated temporary directory");
	const stat = lstatSync(root);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
	)
		throw new Error("Unsafe smoke profile ownership");
	const paths = {
		userData: join(root, "profile"),
		sessionData: join(root, "session"),
		logs: join(root, "logs"),
		crashDumps: join(root, "crashes"),
	};
	const allowed = new Set(["profile", "session", "logs", "crashes"]);
	if (readdirSync(root).some((name) => !allowed.has(name))) throw new Error("Unexpected smoke profile contents");
	for (const path of Object.values(paths)) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)
			throw new Error("Unsafe smoke profile child");
	}
	return paths;
}
