import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../../components/ui/popover.tsx";
import {
	ConversationPreviewInteraction,
	inPreviewCorridor,
	type PreviewMode,
} from "./conversation-preview-interaction.ts";

const focusableSelector =
	'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
function visibleControls(root: ParentNode) {
	return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
		(element) => !element.closest("[inert], [hidden]") && element.getClientRects().length > 0,
	);
}

export type PreviewActions = (controls: {
	previewContent: ReactNode;
	menuPosition: { sideOffset: number; alignOffset: number };
	onMenuOpen: () => void;
	onOverlayChange: (owner: "menu" | "dialog", open: boolean) => void;
	onReturnFocus: () => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
	inlineActions: boolean;
	active: boolean;
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
	menuPreview,
	renderActions,
}: {
	className: string;
	selected: boolean;
	containsCurrent?: boolean;
	dialogOpen?: boolean;
	titleId: string;
	children: ReactNode | ((state: { hovered: boolean }) => ReactNode);
	preview: (controls: { close: () => void; returnFocus: () => void }) => ReactNode;
	menuPreview?: ReactNode;
	renderActions?: PreviewActions;
}) {
	const [mode, setMode] = useState<PreviewMode>("closed");
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [corridor, setCorridor] = useState<{ x: number; y: number; target: "row" | "card" } | null>(null);
	const [menuPosition, setMenuPosition] = useState({ sideOffset: 2, alignOffset: 0 });
	const [interaction] = useState(() => new ConversationPreviewInteraction(setMode));
	const trigger = useRef<HTMLButtonElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const restoringFocus = useRef(false);
	const source = useRef<HTMLElement | null>(null);
	useEffect(() => () => interaction.release(), [interaction]);
	useEffect(() => interaction.setOverlayOpen("dialog", dialogOpen), [dialogOpen, interaction]);
	useEffect(() => {
		if (typeof document !== "undefined" && mode === "closed" && !row.current?.contains(document.activeElement))
			setFocused(false);
	}, [mode]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const dismiss = () => {
			setHovered(false);
			setCorridor(null);
			interaction.close("navigate");
		};
		window.addEventListener("blur", dismiss);
		return () => window.removeEventListener("blur", dismiss);
	}, [interaction]);
	useEffect(() => {
		if (!corridor || mode !== "hover") return;
		const move = (event: PointerEvent) => {
			if (event.pointerType !== "mouse") return;
			const target = corridor.target === "card" ? card.current : row.current;
			if (event.target instanceof Node && (row.current?.contains(event.target) || card.current?.contains(event.target)))
				interaction.cancelPending();
			else if (
				target &&
				inPreviewCorridor({ x: event.clientX, y: event.clientY }, corridor, target.getBoundingClientRect())
			)
				interaction.leave(); // Extend only while moving; stopping in the gap must still close.
			else interaction.close();
		};
		document.addEventListener("pointermove", move);
		return () => document.removeEventListener("pointermove", move);
	}, [corridor, interaction, mode]);
	const returnFocus = () => {
		restoringFocus.current = true;
		(trigger.current ?? row.current?.querySelector("button"))?.focus();
		restoringFocus.current = false;
	};
	const returnPreviewFocus = () => {
		restoringFocus.current = true;
		(source.current?.isConnected
			? source.current
			: (row.current?.querySelector<HTMLElement>(".project-open, .conversation-link") ??
				row.current?.querySelector<HTMLElement>("button"))
		)?.focus({
			preventScroll: true,
		});
		restoringFocus.current = false;
	};
	const previewContent = preview({
		close: () => interaction.close("navigate"),
		returnFocus: returnPreviewFocus,
	});
	return (
		<Popover
			open={mode !== "closed"}
			onOpenChange={(open) => {
				if (!open) interaction.close();
			}}
		>
			<PopoverAnchor asChild>
				{/* biome-ignore lint/a11y/useSemanticElements: This navigation row groups independent controls, not form fields. */}
				<div
					ref={row}
					className={`sidebar-preview-row ${className}`}
					data-selected={selected}
					data-current={selected}
					data-contains-current={containsCurrent}
					data-preview-open={mode !== "closed"}
					role="group"
					aria-labelledby={titleId}
					onPointerEnter={(event) => {
						if (event.pointerType !== "mouse" && event.currentTarget.contains(event.target as Node)) setFocused(true);
						if (
							!dialogOpen &&
							event.pointerType === "mouse" &&
							event.target instanceof Node &&
							event.currentTarget.contains(event.target)
						) {
							setHovered(true);
							setCorridor(null);
							interaction.enter(event.target instanceof Element && !!event.target.closest("[data-preview-immediate]"));
						}
					}}
					onPointerMove={(event) => {
						if (
							event.pointerType === "mouse" &&
							event.target instanceof Element &&
							event.currentTarget.contains(event.target) &&
							event.target.closest("[data-preview-immediate]")
						)
							interaction.enter(true);
					}}
					onPointerLeave={(event) => {
						if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
						setHovered(false);
						if (mode === "hover") setCorridor({ x: event.clientX, y: event.clientY, target: "card" });
						if (!row.current?.querySelector(":focus-visible")) interaction.leave();
					}}
					onFocusCapture={(event) => {
						if (event.currentTarget.contains(event.target)) setFocused(true);
						if (
							!dialogOpen &&
							!restoringFocus.current &&
							event.currentTarget.contains(event.target) &&
							event.target.matches(":focus-visible")
						) {
							source.current = event.target;
							setFocused(true);
							interaction.enter(true);
						}
					}}
					onBlurCapture={(event) => {
						if (
							event.currentTarget.contains(event.target) &&
							!event.currentTarget.contains(event.relatedTarget) &&
							!card.current?.contains(event.relatedTarget)
						) {
							setFocused(false);
							interaction.leave();
						}
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
					onKeyDown={(event) => {
						if (
							event.key !== "Tab" ||
							event.shiftKey ||
							event.altKey ||
							event.ctrlKey ||
							event.metaKey ||
							event.nativeEvent.isComposing ||
							event.nativeEvent.keyCode === 229 ||
							mode === "closed" ||
							!(event.target instanceof HTMLElement) ||
							!event.currentTarget.contains(event.target) ||
							!event.target.matches(".project-open, .conversation-link")
						)
							return;
						const first = card.current && visibleControls(card.current)[0];
						if (!first) return;
						event.preventDefault();
						source.current = event.target;
						interaction.pin();
						first.focus();
					}}
				>
					{typeof children === "function" ? children({ hovered }) : children}
					{renderActions?.({
						previewContent: menuPreview ?? previewContent,
						menuPosition,
						triggerRef: trigger,
						inlineActions: true,
						active: hovered || focused || mode !== "closed",
						onMenuOpen: () => {
							if (row.current && trigger.current) {
								const anchor = row.current.getBoundingClientRect();
								const button = trigger.current.getBoundingClientRect();
								setMenuPosition({
									sideOffset: anchor.right - button.right + 2,
									alignOffset: anchor.top - button.top,
								});
							}
							interaction.close("navigate");
						},
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
				sideOffset={2}
				collisionPadding={12}
				aria-labelledby={titleId}
				tabIndex={-1}
				onPointerEnter={() => {
					setCorridor(null);
					interaction.cancelPending();
				}}
				onPointerLeave={(event) => {
					if (mode === "hover") setCorridor({ x: event.clientX, y: event.clientY, target: "row" });
					interaction.leave();
				}}
				onFocusCapture={() => interaction.pin()}
				onKeyDown={(event) => {
					if (
						event.key !== "Tab" ||
						event.altKey ||
						event.ctrlKey ||
						event.metaKey ||
						event.nativeEvent.isComposing ||
						event.nativeEvent.keyCode === 229 ||
						!card.current
					)
						return;
					const controls = visibleControls(card.current);
					if (event.shiftKey && event.target === controls[0]) {
						event.preventDefault();
						returnPreviewFocus();
					} else if (!event.shiftKey && event.target === controls.at(-1)) {
						const ordered = visibleControls(document);
						const index = source.current ? ordered.indexOf(source.current) : -1;
						const next =
							index >= 0 ? ordered.slice(index + 1).find((item) => !card.current?.contains(item)) : undefined;
						event.preventDefault();
						interaction.close("navigate");
						restoringFocus.current = true;
						(next ?? source.current)?.focus();
						restoringFocus.current = false;
					}
				}}
				onOpenAutoFocus={(event) => {
					if (interaction.mode === "hover") event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (interaction.consumeFocusReturn()) returnPreviewFocus();
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
