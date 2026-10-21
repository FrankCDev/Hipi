import type { ReactNode } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import type { ProjectHomeState } from "./composer/entry-state.ts";
import { workbenchLabels } from "./workbench-labels.ts";
import "./composer/home-layout.css";

export function WorkbenchWelcome({
	workspaceName,
	projectState = workspaceName ? "ready" : "projectless",
	projectSelector,
	context,
	action,
}: {
	workspaceName?: string;
	projectState?: ProjectHomeState;
	projectSelector?: ReactNode;
	context?: ReactNode;
	action: ReactNode;
}) {
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	return (
		<section className="welcome" data-project-ready={projectState === "ready"} data-project-state={projectState}>
			<div className="welcome-hero">
				{projectState === "pending" || projectState === "error" ? (
					<div className="welcome-heading-placeholder" aria-hidden="true" />
				) : (
					<h1>
						<span>
							{projectState === "ready" && workspaceName ? (
								<>
									{l["workbench.projectQuestionStart"]}
									{projectSelector ?? workspaceName}
									{l["workbench.projectQuestionEnd"]}
								</>
							) : (
								l["workbench.taskHeading"]
							)}
						</span>
					</h1>
				)}
			</div>
			<div className="welcome-action conversation-column">
				{context && <div className="welcome-context">{context}</div>}
				<div className="welcome-composer">{action}</div>
			</div>
		</section>
	);
}
