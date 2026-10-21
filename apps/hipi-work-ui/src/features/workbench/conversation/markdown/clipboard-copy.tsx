import { Check, Copy } from "lucide-react";
import { usePreferences } from "../../../../app/preferences.tsx";
import { ActionTooltip } from "../../../../components/ui/action-tooltip.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { markdownLabels } from "./labels.ts";
import { useClipboardFeedback } from "./use-clipboard-feedback.ts";

type ClipboardCopyProps = {
	text: string;
	label: string;
	disabled?: boolean;
	disabledLabel?: string;
	className?: string;
	containerClassName?: string;
	errorClassName?: string;
	variant?: "ghost" | "outline";
	iconOnly?: boolean;
};

/** A changed source owns new feedback; an old write can never label the new content copied. */
export function ClipboardCopy(props: ClipboardCopyProps) {
	return <ClipboardCopyAction key={props.text} {...props} />;
}

function ClipboardCopyAction({
	text,
	label,
	disabled = false,
	disabledLabel,
	className,
	containerClassName,
	errorClassName,
	variant = "ghost",
	iconOnly = false,
}: ClipboardCopyProps) {
	const { t, locale } = usePreferences();
	const clipboard = useClipboardFeedback();
	const copied = clipboard.status === "copied";
	const pending = clipboard.status === "copying";
	const feedback = pending ? markdownLabels(locale)["markdown.copying"] : copied ? t("common.copied") : label;
	const accessibleLabel = disabled ? (disabledLabel ?? label) : feedback;
	return (
		<div className={containerClassName}>
			<ActionTooltip label={accessibleLabel} disabled={disabled || pending}>
				<Button
					className={className}
					size={iconOnly ? "icon-sm" : "sm"}
					variant={variant}
					disabled={disabled || pending}
					aria-label={accessibleLabel}
					onClick={() => {
						if (!disabled) clipboard.copy(text);
					}}
				>
					{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
					<span className={iconOnly ? "sr-only" : undefined} aria-live="polite">
						{feedback}
					</span>
				</Button>
			</ActionTooltip>
			{clipboard.status === "failed" && (
				<p className={errorClassName} role="alert">
					{t("common.copyFailed")}
				</p>
			)}
		</div>
	);
}
