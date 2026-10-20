import type { Conversation, Params, Workspace } from "../contracts.ts";
import type { ProjectRequest, ProjectResponse } from "./contracts.ts";

/** Uses the existing runtime workspace cache and physical directory command owner. */
export type ProjectCreationPorts = {
	createWorkspace(input: Params<"createWorkspace">): Promise<Workspace>;
	createConversation(input: Params<"createConversation">): Promise<Conversation>;
};
export type ProjectRuntimePort = (request: ProjectRequest, creation: ProjectCreationPorts) => Promise<ProjectResponse>;
