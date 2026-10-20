import type { ReactNode } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { workbenchLabels } from "./workbench-labels.ts";

export function WorkbenchWelcome({ workspaceName, action }: { workspaceName?: string; action: ReactNode }) {
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	return (
		<section className="welcome" data-project-ready={!!workspaceName}>
			<h1>{workspaceName ?? l["workbench.taskHeading"]}</h1>
			<div className="welcome-action">{action}</div>
		</section>
	);
}
