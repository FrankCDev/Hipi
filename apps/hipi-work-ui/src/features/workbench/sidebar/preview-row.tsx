import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
	ActionMenuBoundary,
	ActionMenuContextTrigger,
	type ActionMenuEntry,
	type ActionMenuState,
} from "../../../components/ui/action-menu.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "../../../components/ui/popover.tsx";
import { SidebarTooltipBoundary } from "./action-tooltip.tsx";
import { useSidebarBranchAvailability } from "./branch-availability.tsx";
import {
	ConversationPreviewInteraction,
	inPreviewCorridor,
	type PreviewMode,
} from "./conversation-preview-interaction.ts";
import { type SidebarOrderAction, useSidebarDragging, useSidebarSortable } from "./drag-provider.tsx";
import { useSidebarPreviewCoordinator, useSidebarPreviewDisabled } from "./preview-provider.tsx";
import { useSidebarSection } from "./section.tsx";
import { useWindowInteraction } from "./window-interaction.tsx";

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
	rowMenu?: ActionMenuState;
	onMenuOpen: () => void;
	onOverlayChange: (owner: "menu" | "dialog", open: boolean) => void;
	onReturnFocus: (reason?: "dialog") => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
	inlineActions: boolean;
	active: boolean;
	hidden: boolean;
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
	orderAction,
}: {
	className: string;
	selected: boolean;
	containsCurrent?: boolean;
	dialogOpen?: boolean;
	titleId: string;
	children: ReactNode | ((state: { hovered: boolean; describedBy?: string }) => ReactNode);
	preview: (controls: { close: () => void; returnFocus: () => void }) => ReactNode;
	menuPreview?: ReactNode;
	renderActions?: PreviewActions;
	orderAction?: SidebarOrderAction;
}) {
	const dragging = useSidebarDragging();
	const protectWindow = useWindowInteraction();
	const windowOwner = useId();
	const surfaceDisabled = useSidebarPreviewDisabled();
	const surfaceState = useRef(surfaceDisabled);
	surfaceState.current = surfaceDisabled;
	const section = useSidebarSection();
	const branch = useSidebarBranchAvailability();
	const hidden = surfaceDisabled || (section?.collapsed ?? false) || (branch?.collapsed ?? false);
	const branchOwner = useRef(branch);
	branchOwner.current = branch;
	const sectionOwner = useRef(section);
	sectionOwner.current = section;
	const coordinator = useSidebarPreviewCoordinator();
	const row = useRef<HTMLDivElement>(null);
	const sortable = useSidebarSortable(orderAction, true, row);
	const [mode, setMode] = useState<PreviewMode>("closed");
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const corridor = useRef<{ x: number; y: number; target: "row" | "card" } | null>(null);
	const [menuPosition, setMenuPosition] = useState({ sideOffset: 2, alignOffset: 0 });
	const trigger = useRef<HTMLButtonElement>(null);
	const menuSource = useRef<HTMLElement | null>(null);
	const ownedDialog = useRef(false);
	const focusOwner = useRef<EventTarget | null>(null);
	const [menu, setMenu] = useState<{ entry: ActionMenuEntry; open: boolean }>({ entry: "ellipsis", open: false });
	useLayoutEffect(() => {
		protectWindow?.(windowOwner, menu.open || dialogOpen, row.current);
		return () => protectWindow?.(windowOwner, false);
	}, [protectWindow, windowOwner, menu.open, dialogOpen]);
	useEffect(
		() => () => {
			protectWindow?.(`${windowOwner}:dialog`, false);
			protectWindow?.(`${windowOwner}:portal`, false);
		},
		[protectWindow, windowOwner],
	);
	const contextPosition = useRef<ActionMenuState["contextPosition"]>(undefined);
	const card = useRef<HTMLDivElement>(null);
	const [interaction] = useState(
		() =>
			new ConversationPreviewInteraction(
				setMode,
				coordinator,
				() => !!card.current?.contains(card.current.ownerDocument.activeElement),
			),
	);
	const restoringFocus = useRef(false);
	const source = useRef<HTMLElement | null>(null);
	const menuState = useRef(menu);
	menuState.current = menu;
	const unavailable = useRef(false);
	unavailable.current = hidden || dragging || dialogOpen || !renderActions;
	const changeMenu = (entry: ActionMenuEntry, open: boolean) => {
		// A late dismissal from the previous primitive must not close the new entry.
		if (!open && menuState.current.entry !== entry) return;
		if (open && (unavailable.current || ownedDialog.current)) return;
		if (open && entry === "ellipsis") {
			menuSource.current = trigger.current;
			if (row.current && trigger.current) {
				const anchor = row.current.getBoundingClientRect();
				const button = trigger.current.getBoundingClientRect();
				setMenuPosition({ sideOffset: anchor.right - button.right + 2, alignOffset: anchor.top - button.top });
			}
		}
		menuState.current = { entry, open };
		setMenu(menuState.current);
		interaction.setOverlayOpen("menu", open);
	};
	const rowMenu: ActionMenuState = {
		...menu,
		open: menu.open && !hidden && !dragging,
		contextPosition: contextPosition.current,
		onOpenChange: changeMenu,
	};
	useEffect(() => {
		interaction.resume();
		return () => interaction.release();
	}, [interaction]);
	useLayoutEffect(() => {
		if (!hidden && !dragging) return;
		setHovered(false);
		setFocused(false);
		corridor.current = null;
		interaction.close("navigate");
		interaction.setOverlayOpen("menu", false);
		if (menuState.current.open) {
			menuState.current = { ...menuState.current, open: false };
			setMenu(menuState.current);
		}
	}, [hidden, dragging, interaction]);
	useEffect(() => interaction.setOverlayOpen("dialog", dialogOpen), [dialogOpen, interaction]);
	useEffect(() => {
		if (typeof document !== "undefined" && mode === "closed" && !row.current?.contains(document.activeElement))
			setFocused(false);
	}, [mode]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const dismiss = () => {
			setHovered(false);
			corridor.current = null;
			interaction.close("navigate");
		};
		window.addEventListener("blur", dismiss);
		return () => window.removeEventListener("blur", dismiss);
	}, [interaction]);
	useEffect(() => {
		if (typeof document === "undefined") return;
		if (mode !== "hover") {
			corridor.current = null;
			interaction.holdCorridor(false);
			return;
		}
		const move = (event: PointerEvent) => {
			const origin = corridor.current;
			if (!origin || event.pointerType !== "mouse" || interaction.mode !== "hover") return;
			const target = origin.target === "card" ? card.current : row.current;
			if (
				event.target instanceof Node &&
				(row.current?.contains(event.target) || card.current?.contains(event.target))
			) {
				corridor.current = null;
				interaction.holdCorridor(false);
				interaction.cancelPending();
			} else if (
				target &&
				inPreviewCorridor({ x: event.clientX, y: event.clientY }, origin, target.getBoundingClientRect())
			)
				interaction.leave(); // Extend only while moving; stopping in the gap must still close.
			else {
				corridor.current = null;
				interaction.close();
			}
		};
		// Clear an abandoned corridor before the destination row retries this same move.
		document.addEventListener("pointermove", move, true);
		return () => document.removeEventListener("pointermove", move, true);
	}, [interaction, mode]);
	const returnFocus = (reason?: "dialog") => {
		if (surfaceState.current) return;
		if (reason !== "dialog" && menuState.current.open) return;
		if (reason !== "dialog" && ownedDialog.current) return;
		if (sectionOwner.current?.collapsed) {
			const heading = sectionOwner.current.heading.current;
			const active = heading?.ownerDocument.activeElement;
			if (reason === "dialog" && heading && active === heading.ownerDocument.body)
				heading.focus({ preventScroll: true });
			return;
		}
		if (branchOwner.current?.collapsed) {
			const heading = branchOwner.current.heading.current;
			const active = heading?.ownerDocument.activeElement;
			if (
				heading &&
				!heading.closest("[inert], [hidden]") &&
				(active === heading.ownerDocument.body || active === focusOwner.current)
			)
				heading.focus({ preventScroll: true });
			return;
		}
		const doc = menuSource.current?.ownerDocument ?? trigger.current?.ownerDocument;
		const active = doc?.activeElement;
		if (
			doc &&
			active !== doc.body &&
			active !== menuSource.current &&
			active !== trigger.current &&
			active !== focusOwner.current
		)
			return;
		restoringFocus.current = true;
		(menuSource.current?.isConnected
			? menuSource.current
			: (trigger.current ?? row.current?.querySelector("button"))
		)?.focus();
		restoringFocus.current = false;
	};
	const returnPreviewFocus = () => {
		if (surfaceState.current) return;
		if (sectionOwner.current?.collapsed) {
			const heading = sectionOwner.current.heading.current;
			if (heading?.ownerDocument.activeElement === heading?.ownerDocument.body) heading?.focus({ preventScroll: true });
			return;
		}
		if (branchOwner.current?.collapsed) {
			const heading = branchOwner.current.heading.current;
			if (
				heading &&
				!heading.closest("[inert], [hidden]") &&
				heading.ownerDocument.activeElement === heading.ownerDocument.body
			)
				heading.focus({ preventScroll: true });
			return;
		}
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
		<SidebarTooltipBoundary disabled={hidden || dragging || dialogOpen || menu.open || ownedDialog.current}>
			<ActionMenuBoundary state={rowMenu}>
				<Popover
					open={!hidden && mode !== "closed"}
					onOpenChange={(open) => {
						if (!open) interaction.close();
					}}
				>
					<PopoverAnchor asChild>
						<ActionMenuContextTrigger asChild disabled={!renderActions || hidden || dragging || dialogOpen}>
							{/* biome-ignore lint/a11y/useSemanticElements: This navigation row groups independent controls, not form fields. */}
							<div
								ref={row}
								className={`sidebar-preview-row ${className}`}
								data-selected={selected}
								data-current={selected}
								data-contains-current={containsCurrent}
								data-preview-open={mode !== "closed"}
								data-drag-source={sortable["data-drag-source"]}
								data-drag-edge={sortable["data-drag-edge"]}
								data-sidebar-sortable={!!orderAction && !orderAction.item.disabled}
								onPointerDown={(event) => {
									if (event.target instanceof Element && event.target.closest(".project-open, .conversation-link"))
										sortable.onPointerDown(event);
								}}
								role="group"
								aria-labelledby={titleId}
								onContextMenu={(event) => {
									if (
										ownedDialog.current ||
										!(event.target instanceof Element) ||
										!event.currentTarget.contains(event.target)
									) {
										event.preventDefault();
										return;
									}
									menuSource.current =
										event.target.closest<HTMLElement>(focusableSelector) ??
										event.currentTarget.querySelector<HTMLElement>(".project-open, .conversation-link");
									const anchor =
										menuSource.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
									// Native keyboard contextmenu events may carry no pointer coordinates.
									// Position with public Content offsets, never a synthetic click or private anchor.
									contextPosition.current =
										event.clientX === 0 && event.clientY === 0
											? { sideOffset: anchor.left, alignOffset: anchor.bottom }
											: undefined;
								}}
								onPointerEnter={(event) => {
									if (event.pointerType !== "mouse" && event.currentTarget.contains(event.target as Node))
										setFocused(true);
									if (
										!dragging &&
										!hidden &&
										!dialogOpen &&
										event.pointerType === "mouse" &&
										event.target instanceof Node &&
										event.currentTarget.contains(event.target)
									) {
										setHovered(true);
										corridor.current = null;
										interaction.holdCorridor(false);
										if (event.target instanceof Element && event.target.closest("[data-action-tooltip-trigger]")) {
											interaction.close("navigate");
											return;
										}
										interaction.enter(
											event.target instanceof Element && !!event.target.closest("[data-preview-immediate]"),
										);
									}
								}}
								onPointerMove={(event) => {
									if (
										!dragging &&
										!hidden &&
										!dialogOpen &&
										event.pointerType === "mouse" &&
										event.target instanceof Element &&
										event.currentTarget.contains(event.target)
									) {
										if (event.target.closest("[data-action-tooltip-trigger]")) interaction.close("navigate");
										else interaction.enter(!!event.target.closest("[data-preview-immediate]"));
									}
								}}
								onPointerLeave={(event) => {
									if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
									setHovered(false);
									if (interaction.mode === "hover") {
										corridor.current = { x: event.clientX, y: event.clientY, target: "card" };
										interaction.holdCorridor(true);
									}
									if (!row.current?.querySelector(":focus-visible")) interaction.leave();
								}}
								onFocusCapture={(event) => {
									focusOwner.current = event.target;
									if (event.currentTarget.contains(event.target)) setFocused(true);
									if (
										!dragging &&
										!hidden &&
										!dialogOpen &&
										!restoringFocus.current &&
										event.currentTarget.contains(event.target) &&
										event.target.matches(":focus-visible")
									) {
										if (event.target.closest("[data-action-tooltip-trigger]")) {
											interaction.close("navigate");
											return;
										}
										source.current = event.target;
										setFocused(true);
										interaction.enter(true, true);
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
									if (event.target instanceof Element && event.target.matches(".project-open, .conversation-link")) {
										sortable.onKeyDown(event);
										if (event.defaultPrevented) return;
									}
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
								{typeof children === "function"
									? children({ hovered: hovered && !dragging && !hidden, describedBy: sortable.describedBy })
									: children}
								{renderActions?.({
									previewContent: menuPreview ?? previewContent,
									menuPosition,
									rowMenu,
									triggerRef: trigger,
									inlineActions: true,
									active: hovered || focused || mode !== "closed",
									hidden,
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
									onOverlayChange: (owner, open) => {
										if (owner === "dialog") ownedDialog.current = open;
										if (owner === "dialog") protectWindow?.(`${windowOwner}:dialog`, open, row.current);
										interaction.setOverlayOpen(owner, open);
									},
									onReturnFocus: returnFocus,
								})}
							</div>
						</ActionMenuContextTrigger>
					</PopoverAnchor>
					<PopoverContent
						onEscapeKeyDown={(event) => {
							// Radix handles Escape at document capture, before the inline editor.
							if (event.target instanceof Element && event.target.closest("[data-project-inline-rename]"))
								event.preventDefault();
						}}
						onContextMenu={(event) => event.stopPropagation()}
						ref={card}
						className="conversation-preview-card"
						data-sidebar-row-portal=""
						side="right"
						align="start"
						sideOffset={2}
						collisionPadding={12}
						aria-labelledby={titleId}
						tabIndex={-1}
						onPointerEnter={() => {
							corridor.current = null;
							interaction.holdCorridor(false);
							interaction.cancelPending();
						}}
						onPointerLeave={(event) => {
							if (interaction.mode === "hover") {
								corridor.current = { x: event.clientX, y: event.clientY, target: "row" };
								interaction.holdCorridor(true);
							}
							interaction.leave();
						}}
						onFocusCapture={() => {
							interaction.pin();
							protectWindow?.(`${windowOwner}:portal`, true, row.current);
						}}
						onBlurCapture={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget)) protectWindow?.(`${windowOwner}:portal`, false);
						}}
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
			</ActionMenuBoundary>
		</SidebarTooltipBoundary>
	);
}
