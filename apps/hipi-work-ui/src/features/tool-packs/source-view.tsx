import { Textarea } from "../../components/ui/textarea.tsx";
import { toolPackLabels } from "./labels.ts";
/** Untrusted package content is always a text node, never Markdown or executable markup. */
export function ToolPackSource({
	locale,
	digest,
	packageText,
}: {
	locale: string;
	digest: string;
	packageText: string;
}) {
	const l = toolPackLabels(locale);
	return (
		<section className="grid gap-2 border-t border-border pt-3 text-sm">
			<h3 className="font-medium">{l["toolPacks.sourceTitle"]}</h3>
			<p>{l["toolPacks.unverified"]}</p>
			<p className="break-all">{digest}</p>
			<Textarea
				readOnly
				rows={10}
				value={packageText}
				aria-label={l["toolPacks.sourceTitle"]}
				className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono focus-visible:outline-ring"
			/>
		</section>
	);
}
