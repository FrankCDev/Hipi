import { FolderOpen, Layers3, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { BrandMark } from "../../components/brand-mark.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { workbenchLabels } from "./workbench-labels.ts";

export function WorkbenchWelcome({ workspaceName, action }: { workspaceName?: string; action: ReactNode }) {
	const { t, locale } = usePreferences();
	const l = workbenchLabels(locale);
	return (
		<section className="welcome">
			<div className="welcome-mark" aria-hidden="true">
				<BrandMark size={42} />
			</div>
			<p className="welcome-eyebrow">
				{workspaceName && <FolderOpen size={15} aria-hidden="true" />}
				{workspaceName ?? l["workbench.welcomeEyebrow"]}
			</p>
			<h1>{t("work.emptyTitle")}</h1>
			<p>{l[workspaceName ? "workbench.workspaceBody" : "workbench.welcomeBody"]}</p>
			<div className="welcome-action">{action}</div>
			<div className="welcome-principles">
				{(
					[
						["goal", Sparkles],
						["context", ShieldCheck],
						["result", Layers3],
					] as const
				).map(([kind, PrincipleIcon]) => (
					<div key={kind}>
						<PrincipleIcon size={19} aria-hidden="true" />
						<h2>{l[`workbench.${kind}Title`]}</h2>
						<p>{l[`workbench.${kind}Body`]}</p>
					</div>
				))}
			</div>
			<div className="welcome-footnote">
				<Icon name="info" size={14} />
				<span>{t("model.runtimeNote")}</span>
			</div>
		</section>
	);
}
