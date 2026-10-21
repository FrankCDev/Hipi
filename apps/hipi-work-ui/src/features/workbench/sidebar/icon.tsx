import { ChevronRight, Ellipsis, Folder, FolderOpen, PanelLeft, Pin, Search, SquarePen } from "lucide-react";

const icons = {
	newChat: SquarePen,
	folder: Folder,
	folderOpen: FolderOpen,
	panel: PanelLeft,
	search: Search,
	disclosure: ChevronRight,
	more: Ellipsis,
	pin: Pin,
	pinned: Pin,
};

/** Public icon library, with one lightweight desktop-navigation optical role.
 * These are semantic equivalents, not copied application artwork. */
export function SidebarIcon({ name }: { name: keyof typeof icons }) {
	const Glyph = icons[name];
	return (
		<Glyph
			aria-hidden="true"
			className="sidebar-icon"
			data-sidebar-icon={name}
			fill={name === "pinned" ? "currentColor" : "none"}
		/>
	);
}
