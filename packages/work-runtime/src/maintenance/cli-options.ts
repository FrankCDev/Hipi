import { parseArgs } from "node:util";

export type StoreCommand =
	| { command: "help" }
	| { command: "backup"; source: string; destination: string }
	| { command: "verify"; backup: string }
	| { command: "restore"; backup: string; destination: string }
	| { command: "inspect"; archive: string }
	| { command: "workspaces"; archive: string; cursor?: string }
	| { command: "conversations"; archive: string; workspace: string; cursor?: string }
	| { command: "history"; archive: string; workspace: string; conversation: string; cursor?: string }
	| { command: "activities"; archive: string; workspace: string; conversation: string; cursor?: string }
	| {
			command: "activity-text";
			archive: string;
			workspace: string;
			conversation: string;
			activity: string;
			cursor?: string;
	  }
	| { command: "text"; archive: string; workspace: string; conversation: string; message: string; offset: number }
	| { command: "export-history"; archive: string; workspace: string; conversation: string; output: string };

export const STORE_HELP = `Hipi Work offline store maintenance

Run with Node 24.19.0 or later:
  node --conditions=source packages/work-runtime/src/store-cli.ts <command> [options]

Commands:
  backup --source <closed-store> --destination <new-backup-directory>
  verify --backup <backup-directory>
  restore --backup <backup-directory> --destination <new-archive-directory>
  inspect --archive <archive-directory>
  workspaces --archive <archive-directory> [--cursor <cursor>]
  conversations --archive <archive-directory> --workspace <id> [--cursor <cursor>]
  history --archive <archive-directory> --workspace <id> --conversation <id> [--cursor <cursor>]
  activities --archive <archive-directory> --workspace <id> --conversation <id> [--cursor <cursor>]
  activity-text --archive <archive-directory> --workspace <id> --conversation <id> --activity <id> [--cursor <cursor>]
  text --archive <archive-directory> --workspace <id> --conversation <id> --message <id> --offset <offset>
  export-history --archive <archive-directory> --workspace <id> --conversation <id> --output <new-file>

Stop the client and backend before backup. Existing outputs are never overwritten.
Restore creates a separate read-only historical archive. It never resumes old tasks.
Backups and exports contain private work content; protect them like the original store.
No model, credentials, network service, or external project files are restored.
`;

/** Reject ambiguous or ignored arguments before opening any database or creating output. */
export function parseStoreCommand(args: string[]): StoreCommand {
	const { values, positionals, tokens } = parseArgs({
		args,
		strict: true,
		allowPositionals: true,
		tokens: true,
		options: {
			help: { type: "boolean" },
			source: { type: "string" },
			destination: { type: "string" },
			backup: { type: "string" },
			archive: { type: "string" },
			workspace: { type: "string" },
			conversation: { type: "string" },
			message: { type: "string" },
			activity: { type: "string" },
			offset: { type: "string" },
			output: { type: "string" },
			cursor: { type: "string" },
		},
	});
	const fail = (): never => {
		throw new Error("INVALID_ARGUMENTS");
	};
	const seen = new Set<string>();
	for (const token of tokens) {
		if (token.kind !== "option") continue;
		if (seen.has(token.name)) fail();
		seen.add(token.name);
	}
	if (args.length === 0 || (values.help === true && positionals.length === 0 && seen.size === 1))
		return { command: "help" };
	if (positionals.length !== 1 || values.help !== undefined) fail();
	const requireFields = (...names: (keyof typeof values)[]) => {
		if (Object.keys(values).some((key) => !names.includes(key as keyof typeof values))) fail();
	};
	const required = (name: keyof typeof values): string => {
		const value = values[name];
		if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return fail();
		return value;
	};
	const cursor = values.cursor === undefined ? {} : { cursor: required("cursor") };
	switch (positionals[0]) {
		case "backup":
			requireFields("source", "destination");
			return { command: "backup", source: required("source"), destination: required("destination") };
		case "verify":
			requireFields("backup");
			return { command: "verify", backup: required("backup") };
		case "restore":
			requireFields("backup", "destination");
			return { command: "restore", backup: required("backup"), destination: required("destination") };
		case "inspect":
			requireFields("archive");
			return { command: "inspect", archive: required("archive") };
		case "workspaces":
			requireFields("archive", "cursor");
			return { command: "workspaces", archive: required("archive"), ...cursor };
		case "conversations":
			requireFields("archive", "workspace", "cursor");
			return { command: "conversations", archive: required("archive"), workspace: required("workspace"), ...cursor };
		case "history":
		case "activities":
			requireFields("archive", "workspace", "conversation", "cursor");
			return {
				command: positionals[0],
				archive: required("archive"),
				workspace: required("workspace"),
				conversation: required("conversation"),
				...cursor,
			};
		case "activity-text":
			requireFields("archive", "workspace", "conversation", "activity", "cursor");
			return {
				command: "activity-text",
				archive: required("archive"),
				workspace: required("workspace"),
				conversation: required("conversation"),
				activity: required("activity"),
				...cursor,
			};
		case "text": {
			requireFields("archive", "workspace", "conversation", "message", "offset");
			const raw = required("offset");
			if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail();
			return {
				command: "text",
				archive: required("archive"),
				workspace: required("workspace"),
				conversation: required("conversation"),
				message: required("message"),
				offset: Number(raw),
			};
		}
		case "export-history":
			requireFields("archive", "workspace", "conversation", "output");
			return {
				command: "export-history",
				archive: required("archive"),
				workspace: required("workspace"),
				conversation: required("conversation"),
				output: required("output"),
			};
		default:
			return fail();
	}
}
