import { FilePenLine, ListChecks, SearchCheck } from "lucide-react";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { workbenchLabels } from "../workbench-labels.ts";

/** Suggestions edit the current draft only. They never create or submit work. */
export function ConversationStarters({
	hasDraft,
	disabled,
	onSelect,
}: {
	hasDraft: boolean;
	disabled: boolean;
	onSelect: (text: string) => void;
}) {
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	return (
		<section className="conversation-starters" aria-label={l["workbench.starters"]}>
			<p>{l["workbench.starterHint"]}</p>
			<div className="starter-actions">
				{(
					[
						["plan", ListChecks],
						["write", FilePenLine],
						["solve", SearchCheck],
					] as const
				).map(([kind, StarterIcon]) => (
					<Button
						key={kind}
						variant="outline"
						disabled={hasDraft || disabled}
						onClick={() => onSelect(l[`workbench.starter.${kind}Prompt`])}
					>
						<StarterIcon size={16} aria-hidden="true" />
						{l[`workbench.starter.${kind}`]}
					</Button>
				))}
			</div>
		</section>
	);
}
