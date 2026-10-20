import type { ProjectCatalogState, ProjectMethods } from "@hipi/work-runtime/contracts";
import type { LocalState } from "../local-state.ts";

export type DefaultRoleEvidence =
	| { kind: "absent" }
	| { kind: "verified"; workspaceId: string }
	| { kind: "unresolved" };

/** Only the durable role marker is startup evidence. Legacy commands remain owned by legacy recovery. */
export function defaultRoleEvidence(local: LocalState): DefaultRoleEvidence {
	try {
		const raw = local.storedValue("default-chat-workspace")?.value;
		if (raw === undefined) return { kind: "absent" };
		const marker: unknown = JSON.parse(raw);
		if (
			!marker ||
			typeof marker !== "object" ||
			Array.isArray(marker) ||
			Object.keys(marker).some((key) => !["version", "role", "workspaceId"].includes(key)) ||
			!("version" in marker) ||
			marker.version !== 1 ||
			!("role" in marker) ||
			marker.role !== "default-chat-workspace" ||
			!("workspaceId" in marker) ||
			typeof marker.workspaceId !== "string" ||
			!/^[a-zA-Z0-9_-]{1,128}$/.test(marker.workspaceId)
		)
			return { kind: "unresolved" };
		return { kind: "verified", workspaceId: marker.workspaceId };
	} catch {
		return { kind: "unresolved" };
	}
}

export function legacyAdoptionInput(
	local: LocalState,
	state: ProjectCatalogState,
): ProjectMethods["adoptLegacyDefaultWorkspace"]["params"] | null {
	const evidence = defaultRoleEvidence(local);
	if (
		!local.storeIdentity ||
		evidence.kind !== "verified" ||
		state.defaultWorkspaceId === evidence.workspaceId ||
		state.state === "adopting"
	)
		return null;
	return {
		requestId: crypto.randomUUID(),
		workspaceId: evidence.workspaceId,
		expectedCatalogGeneration: state.generation,
		expectedDefaultWorkspaceId: state.defaultWorkspaceId,
		provenance: {
			storeId: local.storeIdentity,
			markerVersion: 1,
			role: "default-chat-workspace",
			workspaceId: evidence.workspaceId,
		},
	};
}

export function canCreateProjectless(local: LocalState, state: ProjectCatalogState | undefined): boolean {
	if (!state || state.state !== "ready") return false;
	const evidence = defaultRoleEvidence(local);
	return (
		evidence.kind === "absent" || (evidence.kind === "verified" && state.defaultWorkspaceId === evidence.workspaceId)
	);
}
