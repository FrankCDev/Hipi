import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { ActionTooltip } from "../../../components/ui/action-tooltip.tsx";
import { useSidebarDragging } from "./drag-provider.tsx";
import { useSidebarPreviewDisabled } from "./preview-provider.tsx";

const OverlayContext = createContext(false);
export function SidebarTooltipBoundary({ disabled, children }: { disabled: boolean; children: ReactNode }) {
	return <OverlayContext.Provider value={disabled}>{children}</OverlayContext.Provider>;
}

export function SidebarActionTooltip(props: ComponentProps<typeof ActionTooltip>) {
	const overlay = useContext(OverlayContext);
	const dragging = useSidebarDragging();
	const hidden = useSidebarPreviewDisabled();
	return <ActionTooltip {...props} disabled={props.disabled || overlay || dragging || hidden} />;
}
