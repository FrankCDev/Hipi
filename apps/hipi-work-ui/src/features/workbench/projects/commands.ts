import { PROTOCOL_VERSION, type ProjectCommandResult, parseRequest } from "@hipi/work-runtime/contracts";
import type { CatalogCommand, ProjectCatalogCommand } from "../command-recovery.ts";
import type { LocalState } from "../local-state.ts";
import { defaultRoleEvidence } from "./identity.ts";

/** New logical commands have no protocol 8 journal representation. */
export function parseProjectCommand(value: unknown): ProjectCatalogCommand {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("version" in value) ||
		value.version !== PROTOCOL_VERSION ||
		Object.keys(value).some((key) => !["version", "method", "params"].includes(key))
	)
		throw new Error("INVALID_PROJECT_COMMAND");
	const command = parseRequest(value);
	switch (command.method) {
		case "createProject":
		case "createProjectConversation":
		case "renameProject":
		case "setProjectPinned":
		case "reorderPinnedProject":
		case "adoptLegacyDefaultWorkspace":
			return command;
		default:
			throw new Error("INVALID_PROJECT_COMMAND");
	}
}

export function matchesProjectCommand(command: ProjectCatalogCommand, receipt: ProjectCommandResult): boolean {
	return command.method === receipt.method && JSON.stringify(command.params) === JSON.stringify(receipt.params);
}

export function isProjectCatalogCommand(command: CatalogCommand): command is ProjectCatalogCommand {
	return [
		"createProject",
		"createProjectConversation",
		"renameProject",
		"setProjectPinned",
		"reorderPinnedProject",
		"adoptLegacyDefaultWorkspace",
	].includes(command.method);
}

export function admitProjectCommand(local: LocalState, input: ProjectCatalogCommand, signal: AbortSignal) {
	const request = parseProjectCommand(input);
	return local.withAdmission("command.catalog", () => {
		signal.throwIfAborted();
		if (request.method === "adoptLegacyDefaultWorkspace") assertAdoptionEvidence(local, request);
		const previous = local.storedValue("command.catalog")?.value;
		if (previous && previous !== JSON.stringify({ version: 2, request: null }))
			throw new Error("CATALOG_RECOVERY_EXISTS");
		local.persistValue({
			kind: "value",
			key: "command.catalog",
			value: JSON.stringify({ version: 6, kind: "project-command", request }),
		});
		return request;
	});
}

export function assertAdoptionEvidence(
	local: LocalState,
	command: Extract<ProjectCatalogCommand, { method: "adoptLegacyDefaultWorkspace" }>,
) {
	const evidence = defaultRoleEvidence(local);
	if (
		local.storeIdentity !== command.params.provenance.storeId ||
		evidence.kind !== "verified" ||
		evidence.workspaceId !== command.params.workspaceId
	)
		throw new Error("DEFAULT_WORKSPACE_CHANGED");
}

export function finishProjectCommand(local: LocalState, command: ProjectCatalogCommand, signal: AbortSignal) {
	return local.withAdmission("command.catalog", () => {
		signal.throwIfAborted();
		const expected = JSON.stringify({ version: 6, kind: "project-command", request: command });
		if (local.storedValue("command.catalog")?.value !== expected) throw new Error("CATALOG_RECOVERY_MISMATCH");
		local.persistValue({ kind: "value", key: "command.catalog", value: JSON.stringify({ version: 2, request: null }) });
	});
}
