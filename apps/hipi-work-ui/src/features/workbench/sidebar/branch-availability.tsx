import { createContext, type FocusEvent, type RefObject, useContext, useLayoutEffect, useRef } from "react";

type BranchAvailability = {
	collapsed: boolean;
	heading: RefObject<HTMLButtonElement | null>;
};

export const SidebarBranchAvailability = createContext<BranchAvailability | null>(null);
export const useSidebarBranchAvailability = () => useContext(SidebarBranchAvailability);

/** Keep the disclosure owner live outside the temporarily retained exit subtree. */
export function useBranchFocus(collapsed: boolean, heading: RefObject<HTMLButtonElement | null>) {
	const owner = useRef<HTMLElement | null>(null);
	const previousCollapsed = useRef(collapsed);
	const previous =
		collapsed && !previousCollapsed.current && owner.current?.ownerDocument.activeElement === owner.current
			? owner.current
			: null;
	useLayoutEffect(() => {
		previousCollapsed.current = collapsed;
		if (!collapsed) return;
		owner.current = null;
		const button = heading.current;
		if (!previous || !button || button.closest("[inert], [hidden]")) return;
		const dialog = previous.closest('[role="dialog"], [role="alertdialog"]');
		if (dialog && !dialog.classList.contains("conversation-preview-card")) return;
		const doc = button.ownerDocument;
		if (
			doc.activeElement === previous ||
			(doc.activeElement === doc.body && (!previous.isConnected || previous.closest("[inert]")))
		)
			button.focus({ preventScroll: true });
	}, [collapsed, previous, heading]);
	return {
		onFocusCapture(event: FocusEvent<HTMLElement>) {
			// React focus propagation includes this branch's preview/menu/dialog portals.
			owner.current = event.target;
		},
		onBlurCapture(event: FocusEvent<HTMLElement>) {
			if (!collapsed || event.relatedTarget) owner.current = null;
		},
	};
}
