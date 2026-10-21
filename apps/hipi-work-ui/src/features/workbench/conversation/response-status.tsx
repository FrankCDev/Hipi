import { usePreferences } from "../../../app/preferences.tsx";
import { CadencedText } from "./presentation/cadenced-text.tsx";
import { responseLabel } from "./response-labels.ts";
import type { ResponsePhase } from "./response-phase.ts";
import "./response-status.css";

/** A visual waiting state only. The stable ResponseAnnouncement owns live announcements. */
export function ResponseStatus({ phase = "generating" }: { phase?: ResponsePhase }) {
	const { locale } = usePreferences();
	// running alone does not prove reasoning, environment setup or a tool phase.
	const label = responseLabel(`response.${phase}`, locale);
	return (
		<div className="response-status" data-response-phase={phase}>
			<CadencedText>{label}</CadencedText>
		</div>
	);
}
