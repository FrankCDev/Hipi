import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { AppKeybindings } from "../../../app/keybindings.ts";
import { SidebarItemNavigation } from "./item-navigation.ts";

export function SidebarItemNavigationCommands({
	rootRef,
	keybindings,
	enabled,
}: {
	rootRef: RefObject<HTMLElement | null>;
	keybindings: AppKeybindings;
	enabled: boolean;
}) {
	const active = useRef(enabled);
	const owner = useRef<SidebarItemNavigation | null>(null);
	useLayoutEffect(() => {
		active.current = enabled;
		if (!enabled) owner.current?.reset();
	}, [enabled]);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const navigation = new SidebarItemNavigation(
			root,
			keybindings,
			() => active.current,
			/Mac|iPhone|iPad/.test(root.ownerDocument.defaultView?.navigator.platform ?? ""),
		);
		owner.current = navigation;
		const detach = navigation.attach();
		return () => {
			detach();
			if (owner.current === navigation) owner.current = null;
		};
	}, [rootRef, keybindings]);
	return null;
}
