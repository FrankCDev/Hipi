import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../../components/ui/popover.tsx";
import { ConversationPreviewInteraction, type PreviewMode } from "./conversation-preview-interaction.ts";

export type PreviewActions = (controls: {
	previewContent: ReactNode;
	onMenuOpen: () => void;
	onOverlayChange: (owner: "menu" | "dialog", open: boolean) => void;
	onReturnFocus: () => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
}) => ReactNode;

/** One hover/focus boundary for the label and its independent inline actions. */
export function SidebarPreviewRow({
	className,
	selected,
	containsCurrent = false,
	dialogOpen = false,
	titleId,
	children,
	preview,
	renderActions,
}: {
	className: string;
	selected: boolean;
	containsCurrent?: boolean;
	dialogOpen?: boolean;
	titleId: string;
	children: ReactNode;
	preview: () => ReactNode;
	renderActions?: PreviewActions;
}) {
	const [mode, setMode] = useState<PreviewMode>("closed");
	const [interaction] = useState(() => new ConversationPreviewInteraction(setMode));
	const trigger = useRef<HTMLButtonElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const restoringFocus = useRef(false);
	const previewContent = preview();
	useEffect(() => () => interaction.cancelPending(), [interaction]);
	useEffect(() => interaction.setOverlayOpen("dialog", dialogOpen), [dialogOpen, interaction]);
	const returnFocus = () => {
		restoringFocus.current = true;
		(trigger.current ?? row.current?.querySelector("button"))?.focus();
		restoringFocus.current = false;
	};
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
					data-current={selected}
					data-contains-current={containsCurrent}
					onPointerEnter={(event) => {
						if (
							!dialogOpen &&
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
							!dialogOpen &&
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
					{renderActions?.({
						previewContent,
						triggerRef: trigger,
						onMenuOpen: () => interaction.close("navigate"),
						onOverlayChange: (owner, open) => interaction.setOverlayOpen(owner, open),
						onReturnFocus: returnFocus,
					})}
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
					if (interaction.consumeFocusReturn()) returnFocus();
				}}
				onInteractOutside={(event) => {
					if (event.target instanceof Node && row.current?.contains(event.target)) event.preventDefault();
					else interaction.close("navigate");
				}}
			>
				{previewContent}
			</PopoverContent>
		</Popover>
	);
}
