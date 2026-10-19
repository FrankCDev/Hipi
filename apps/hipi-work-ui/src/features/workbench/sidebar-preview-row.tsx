import { Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import { ConversationPreviewInteraction, type PreviewMode } from "./conversation-preview-interaction.ts";

/** One hover/focus boundary for the label and its independent inline actions. */
export function SidebarPreviewRow({
	className,
	selected,
	titleId,
	children,
	preview,
}: {
	className: string;
	selected: boolean;
	titleId: string;
	children: ReactNode;
	preview: (close: () => void, returnFocus: () => HTMLButtonElement | null) => ReactNode;
}) {
	const { t } = usePreferences();
	const actionId = useId();
	const [mode, setMode] = useState<PreviewMode>("closed");
	const [interaction] = useState(() => new ConversationPreviewInteraction(setMode));
	const trigger = useRef<HTMLButtonElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const restoringFocus = useRef(false);
	useEffect(() => () => interaction.cancelPending(), [interaction]);
	return (
		<Popover
			open={mode !== "closed"}
			onOpenChange={(open) => {
				if (!open) interaction.close();
			}}
		>
			<PopoverAnchor asChild>
				<div
					ref={row}
					className={`sidebar-preview-row ${className}`}
					data-selected={selected}
					onPointerEnter={(event) => {
						if (
							event.pointerType === "mouse" &&
							event.target instanceof Node &&
							event.currentTarget.contains(event.target)
						)
							interaction.enter();
					}}
					onPointerLeave={() => {
						if (!row.current?.querySelector(":focus-visible")) interaction.leave();
					}}
					onFocusCapture={(event) => {
						if (
							!restoringFocus.current &&
							event.currentTarget.contains(event.target) &&
							event.target.matches(":focus-visible")
						)
							interaction.enter();
					}}
					onBlurCapture={(event) => {
						if (
							event.currentTarget.contains(event.target) &&
							!event.currentTarget.contains(event.relatedTarget) &&
							!card.current?.contains(event.relatedTarget)
						)
							interaction.leave();
					}}
					onClickCapture={(event) => {
						// Portalled dialog events bubble through React; only row actions dismiss the preview.
						if (
							event.target instanceof Node &&
							event.currentTarget.contains(event.target) &&
							!trigger.current?.contains(event.target)
						)
							interaction.close("navigate");
					}}
				>
					{children}
					<PopoverTrigger asChild>
						<Button
							ref={trigger}
							variant="ghost"
							size="icon-sm"
							className="sidebar-preview-trigger"
							aria-labelledby={`${actionId} ${titleId}`}
							onClick={(event) => {
								event.preventDefault();
								interaction.activate();
								if (interaction.mode === "pinned") card.current?.focus();
							}}
						>
							<Ellipsis size={16} aria-hidden="true" />
							<span className="sr-only" id={actionId}>
								{t("nav.preview")}
							</span>
						</Button>
					</PopoverTrigger>
				</div>
			</PopoverAnchor>
			<PopoverContent
				ref={card}
				className="conversation-preview-card"
				side="right"
				align="start"
				sideOffset={10}
				collisionPadding={12}
				aria-labelledby={titleId}
				tabIndex={-1}
				onPointerEnter={() => interaction.cancelPending()}
				onPointerLeave={() => interaction.leave()}
				onFocusCapture={() => interaction.pin()}
				onOpenAutoFocus={(event) => {
					if (interaction.mode === "hover") event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (interaction.consumeFocusReturn()) {
						restoringFocus.current = true;
						trigger.current?.focus();
						restoringFocus.current = false;
					}
				}}
				onInteractOutside={(event) => {
					if (event.target instanceof Node && row.current?.contains(event.target)) event.preventDefault();
					else interaction.close("navigate");
				}}
			>
				{preview(
					() => interaction.close("navigate"),
					() => trigger.current,
				)}
			</PopoverContent>
		</Popover>
	);
}
