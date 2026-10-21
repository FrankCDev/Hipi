import { usePreferences } from "../../../app/preferences.tsx";
import { CadencedText } from "./presentation/cadenced-text.tsx";
import { responseLabel } from "./response-labels.ts";
import type { ResponsePhase } from "./response-phase.ts";
import "./response-status.css";

/** A visual waiting state only. The stable ResponseAnnouncement owns live announcements. */
export function ResponseStatus({ phase = "generating" }: { phase?: ResponsePhase }) {
	const { locale } = usePreferences();
	// The local-conversation reference calls its no-visible-output fallback
	// "Thinking". It is product copy, not an internal reasoning event or payload.
	const label = responseLabel(`response.${phase}`, locale);
	return (
		<div className="response-status" data-response-phase={phase}>
			<div className="response-status-content">
				<span className="response-status-spacer" aria-hidden="true" />
				<CadencedText>{label}</CadencedText>
			</div>
		</div>
	);
}
