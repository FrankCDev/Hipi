import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useState } from "react";
import { useSidebarDragging } from "./drag-provider.tsx";
import { SidebarPreviewCoordinator } from "./preview-coordinator.ts";

const PreviewContext = createContext<SidebarPreviewCoordinator | null>(null);
const DisabledContext = createContext(false);

export function SidebarPreviewProvider({
	children,
	disabled,
	navigationKey,
}: {
	children: ReactNode;
	disabled: boolean;
	navigationKey: string;
}) {
	const dragging = useSidebarDragging();
	const [coordinator] = useState(() => new SidebarPreviewCoordinator());
	// biome-ignore lint/correctness/useExhaustiveDependencies: Navigation changes retire previews even when the surface remains enabled.
	useLayoutEffect(() => {
		coordinator.setEnabled(!disabled && !dragging);
		return () => coordinator.reset();
	}, [coordinator, disabled, dragging, navigationKey]);
	useEffect(() => {
		const dismiss = () => coordinator.reset();
		window.addEventListener("blur", dismiss);
		return () => {
			window.removeEventListener("blur", dismiss);
			coordinator.dispose();
		};
	}, [coordinator]);
	return (
		<PreviewContext.Provider value={coordinator}>
			<DisabledContext.Provider value={disabled || dragging}>{children}</DisabledContext.Provider>
		</PreviewContext.Provider>
	);
}

export const useSidebarPreviewDisabled = () => useContext(DisabledContext);

export function useSidebarPreviewCoordinator() {
	const coordinator = useContext(PreviewContext);
	if (!coordinator) throw new Error("Sidebar preview requires its navigation provider");
	return coordinator;
}
