import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { type ConversationFailure, conversationFailureCopy } from "./conversation-failure.ts";
import "./conversation-turn-failure.css";

export function ConversationTurnFailure({
	failure,
	onOpenModelSettings,
}: {
	failure: ConversationFailure;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
}) {
	const { locale } = usePreferences();
	const copy = conversationFailureCopy(failure, locale);
	return (
		<section className="conversation-turn-failure" aria-label={copy.title}>
			<Icon name="info" size={16} />
			<div>
				<p>{copy.message}</p>
				<p className="conversation-turn-failure-detail">{copy.detail}</p>
				{onOpenModelSettings && failure.modelFailure?.category !== "model_context_blocked" && (
					<Button variant="ghost" size="sm" onClick={(event) => onOpenModelSettings(event.currentTarget)}>
						{copy.settings}
					</Button>
				)}
			</div>
		</section>
	);
}
