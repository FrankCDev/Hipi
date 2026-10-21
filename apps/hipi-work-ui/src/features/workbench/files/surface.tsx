import { DismissableLayer, useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";
import { useFocusGuards } from "@radix-ui/react-focus-guards";
import { FocusScope, FocusScopeBranchProvider, useFocusScopeBranchRegistry } from "@radix-ui/react-focus-scope";
import { hideOthers } from "aria-hidden";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RemoveScroll } from "react-remove-scroll";

/** Capture-phase cancellation belongs to the nested editor control or IME. */
export function preserveFileEditorEscape(event: KeyboardEvent) {
	if (
		event.isComposing ||
		event.composedPath().some((target) => target instanceof Element && target.hasAttribute("data-file-editor-cancel"))
	)
		event.preventDefault();
}

/** External drawers and nested dialogs own modality while an ancestor is unavailable. */
function unavailable(node: HTMLElement) {
	for (let parent = node.parentElement; parent; parent = parent.parentElement) {
		if (parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true") return true;
	}
	return false;
}
function activeElement() {
	let active = document.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	return active instanceof HTMLElement ? active : null;
}
function containsFocus(node: HTMLElement, target: HTMLElement | null): boolean {
	if (!target) return false;
	if (node.contains(target)) return true;
	const root = target.getRootNode();
	return root instanceof ShadowRoot && containsFocus(node, root.host as HTMLElement);
}
function FocusGuards() {
	useFocusGuards();
	return null;
}

/**
 * Stable, feature-local presentation. Never portal or move the editor host on resize.
 * Mount with the workbench, before its dialogs: passive Radix scopes/layers still
 * occupy their stacks. Do not conditionally mount this shell when opening files.
 */
export function FilePanelSurface({
	open,
	overlay,
	id,
	trigger,
	onClose,
	children,
}: {
	open: boolean;
	overlay: boolean;
	id: string;
	trigger: RefObject<HTMLButtonElement | null>;
	onClose: () => void;
	children: ReactNode;
}) {
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [blocked, setBlocked] = useState(true);
	const { nodes, registry } = useFocusScopeBranchRegistry();
	const backdrop = useDismissableLayerSurface();
	const wasOpen = useRef(open);
	const activationFocus = useRef<HTMLElement | null>(null);
	// Read before acquiring any lease, then observe only the external ancestor chain.
	useLayoutEffect(() => {
		if (!node) return;
		const update = () => setBlocked(unavailable(node));
		update();
		const observer = new MutationObserver(update);
		for (let parent = node.parentElement; parent; parent = parent.parentElement) {
			observer.observe(parent, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
		}
		return () => observer.disconnect();
	}, [node]);
	const modal = open && overlay && !!node && !blocked && !unavailable(node);
	useLayoutEffect(() => {
		if (!modal || !node || unavailable(node)) return;
		// Radix only records focusin while trapped. Preserve the already-focused editor
		// as a fallback for the first outside focus after enabling an existing scope.
		activationFocus.current = containsFocus(node, activeElement()) ? activeElement() : null;
		const restore = hideOthers([node, ...nodes]);
		if (!node.contains(document.activeElement) && !nodes.some((branch) => branch.contains(document.activeElement))) {
			node.querySelector<HTMLElement>(".file-panel-close")?.focus({ preventScroll: true });
		}
		return restore;
	}, [modal, node, nodes]);
	useEffect(() => {
		if (wasOpen.current && !open) trigger.current?.focus({ preventScroll: true });
		wasOpen.current = open;
	}, [open, trigger]);
	return (
		<FocusScopeBranchProvider registry={registry}>
			<div ref={backdrop} className="file-panel-backdrop" hidden={!open || !overlay} aria-hidden="true" />
			<RemoveScroll enabled={modal} forwardProps shards={nodes} allowPinchZoom>
				<FocusScope
					asChild
					trapped={modal}
					loop={modal}
					branches={nodes}
					onMountAutoFocus={(event) => event.preventDefault()}
					onUnmountAutoFocus={(event) => event.preventDefault()}
				>
					<DismissableLayer
						asChild
						disableOutsidePointerEvents={modal}
						deferPointerDownOutside
						onDismiss={modal ? onClose : undefined}
						onFocusOutside={
							modal
								? (event) => {
										event.preventDefault();
										if (!node || unavailable(node) || nodes.some((branch) => branch.contains(document.activeElement)))
											return;
										if (!node.contains(document.activeElement)) {
											const target = activationFocus.current;
											(target?.isConnected && containsFocus(node, target)
												? target
												: node.querySelector<HTMLElement>(".file-panel-close")
											)?.focus({ preventScroll: true });
										}
									}
								: undefined
						}
						onPointerDownOutside={
							modal
								? (event) => {
										const original = event.detail.originalEvent;
										if (original.button === 2 || (original.button === 0 && original.ctrlKey)) event.preventDefault();
									}
								: undefined
						}
						onEscapeKeyDown={modal ? preserveFileEditorEscape : undefined}
					>
						<div
							ref={setNode}
							onFocusCapture={() => {
								const active = activeElement();
								if (node && containsFocus(node, active)) activationFocus.current = active;
							}}
							id={`${id}-content`}
							className={`file-panel-content${overlay ? " file-panel-dialog ui-overlay-surface shadow-lg" : ""}`}
							{...(modal
								? {
										role: "dialog",
										"aria-modal": modal || undefined,
										"aria-labelledby": `${id}-title`,
										"aria-describedby": `${id}-description`,
									}
								: {})}
						>
							{children}
						</div>
					</DismissableLayer>
				</FocusScope>
			</RemoveScroll>
			{modal && <FocusGuards />}
		</FocusScopeBranchProvider>
	);
}
