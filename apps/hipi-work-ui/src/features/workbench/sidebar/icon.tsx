import { ChevronRight, Ellipsis, Folder, PanelLeft, Search, SquarePen } from "lucide-react";

const icons = {
	newChat: SquarePen,
	folder: Folder,
	panel: PanelLeft,
	search: Search,
	disclosure: ChevronRight,
	more: Ellipsis,
};

/** Public icon library, with one lightweight desktop-navigation optical role.
 * These are semantic equivalents, not copied application artwork. */
export function SidebarIcon({ name }: { name: keyof typeof icons }) {
	const Glyph = icons[name];
	return <Glyph aria-hidden="true" className="sidebar-icon" data-sidebar-icon={name} />;
}
