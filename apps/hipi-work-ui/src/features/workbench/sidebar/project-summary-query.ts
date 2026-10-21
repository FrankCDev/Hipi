import type { AppClient, ProjectConversationSummary } from "@hipi/work-runtime/contracts";

export type ProjectPreviewCount = {
	count: number;
	partial: boolean;
	state: ProjectConversationSummary["coverage"]["state"];
};
export type ProjectSummaryCount = ProjectPreviewCount & { coverage: ProjectConversationSummary["coverage"] };

/** Retain publication identity even though the hover card presents only a bounded count. */
export async function readProjectSummary(
	client: AppClient,
	projectId: string,
	signal: AbortSignal,
): Promise<ProjectSummaryCount> {
	const summary = await client.call("getProjectConversationSummary", { projectId, filter: "all" }, signal);
	return {
		count: summary.matchedAtLeast,
		partial: !summary.complete || summary.coverage.state !== "ready",
		state: summary.coverage.state,
		coverage: summary.coverage,
	};
}
