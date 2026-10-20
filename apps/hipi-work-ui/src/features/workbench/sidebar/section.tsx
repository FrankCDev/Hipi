import { AnimatePresence, motion } from "framer-motion";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useId,
	useLayoutEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { useThemeSettings } from "../../../app/theme/index.ts";
import { Icon } from "../../../components/ui/icon.tsx";
import { type SidebarOrderAction, useSidebarSortable } from "./drag-provider.tsx";
import { sidebarSectionLabels } from "./section-labels.ts";

type SectionContext = {
	collapsed: boolean;
	disabled: boolean;
	contentId: string;
	headingId: string;
	heading: RefObject<HTMLButtonElement | null>;
	sortable: ReturnType<typeof useSidebarSortable>;
	setCollapsed: (collapsed: boolean) => void;
};
const Context = createContext<SectionContext | null>(null);
export const useSidebarSection = () => useContext(Context);
const systemMotion = () =>
	typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const serverMotion = () => false;
function subscribeMotion(changed: () => void) {
	const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
	media?.addEventListener("change", changed);
	return () => media?.removeEventListener("change", changed);
}

/** Ordering measures the whole section; its existing disclosure button is the only activator. */
export function SidebarOrderSection({
	action,
	collapsed = false,
	disabled = false,
	onCollapsedChange = () => {},
	children,
}: {
	action: SidebarOrderAction;
	collapsed?: boolean;
	disabled?: boolean;
	onCollapsedChange?: (collapsed: boolean) => void;
	children: ReactNode;
}) {
	const sortable = useSidebarSortable(action);
	const heading = useRef<HTMLButtonElement>(null);
	const focusOwner = useRef<HTMLElement | null>(null);
	const previousCollapsed = useRef(collapsed);
	const collapseFocus =
		collapsed && !previousCollapsed.current && focusOwner.current?.ownerDocument.activeElement === focusOwner.current
			? focusOwner.current
			: null;
	const headingId = useId();
	const contentId = useId();
	useLayoutEffect(() => {
		previousCollapsed.current = collapsed;
		if (!collapsed) return;
		const previous = collapseFocus;
		const button = heading.current;
		if (!previous || !button) return;
		const dialog = previous.closest('[role="dialog"], [role="alertdialog"]');
		if (dialog && !dialog.classList.contains("conversation-preview-card")) return;
		const doc = button.ownerDocument;
		// React focus events include owned portals. Never steal a newer outside/modal focus.
		if (
			doc.activeElement === previous ||
			(doc.activeElement === doc.body && (!previous.isConnected || previous.closest("[inert]")))
		)
			button.focus({ preventScroll: true });
		focusOwner.current = null;
	}, [collapsed, collapseFocus]);
	return (
		<Context.Provider
			value={{ collapsed, disabled, contentId, headingId, heading, sortable, setCollapsed: onCollapsedChange }}
		>
			<div
				ref={(node) => {
					sortable.ref.current = node;
				}}
				className="sidebar-order-section"
				data-drag-source={sortable["data-drag-source"]}
				data-drag-edge={sortable["data-drag-edge"]}
				data-sidebar-section={action.item.id}
				onFocusCapture={(event) => {
					focusOwner.current = event.target.closest(".sidebar-section-content, [data-sidebar-row-portal]")
						? event.target
						: null;
				}}
				onBlurCapture={(event) => {
					if (!collapsed || event.relatedTarget) focusOwner.current = null;
				}}
			>
				{children}
			</div>
		</Context.Provider>
	);
}

export function SidebarSectionHeading({
	children,
	actions,
	titleId,
}: {
	children: string;
	actions?: ReactNode;
	titleId?: string;
}) {
	const section = useSidebarSection();
	const { locale } = usePreferences();
	if (!section)
		return (
			<div className="nav-section-heading sidebar-section-heading">
				<h3 id={titleId}>{children}</h3>
				{actions}
			</div>
		);
	const label = children;
	const labels = sidebarSectionLabels(locale);
	return (
		<div className="nav-section-heading sidebar-section-heading">
			<h3>
				<button
					ref={section.heading}
					id={section.headingId}
					type="button"
					className="sidebar-section-toggle"
					aria-expanded={!section.collapsed}
					aria-controls={section.contentId}
					aria-describedby={section.sortable.describedBy}
					aria-disabled={section.disabled || undefined}
					title={section.collapsed ? labels.expandLabel(label) : labels.collapseLabel(label)}
					onPointerDown={section.sortable.onPointerDown}
					onKeyDown={section.sortable.onKeyDown}
					onClick={() => {
						if (!section.disabled) section.setCollapsed(!section.collapsed);
					}}
				>
					<span id={titleId}>{children}</span>
					<span className="sidebar-section-chevron" data-expanded={!section.collapsed}>
						<Icon name="chevron" size={12} />
					</span>
				</button>
			</h3>
			{actions}
		</div>
	);
}

export function SidebarSectionContent({ children }: { children: ReactNode }) {
	const section = useSidebarSection();
	const { config } = useThemeSettings();
	// Motion's current hook captures its initial media value. Subscribe explicitly
	// so the app's system/on/off preference remains live while this section stays mounted.
	const systemReduced = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
	const reduced = config.reducedMotion === "on" || (config.reducedMotion === "system" && systemReduced);
	if (!section) return <>{children}</>;
	return (
		<section
			id={section.contentId}
			className="sidebar-section-content"
			aria-labelledby={section.headingId}
			aria-hidden={section.collapsed || undefined}
			inert={section.collapsed}
		>
			<AnimatePresence initial={false}>
				{!section.collapsed && (
					<motion.div
						key="content"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
						exit={{ height: 0, opacity: 0, overflow: "hidden" }}
						transition={reduced ? { duration: 0 } : { duration: 0.3, ease: [0.19, 1, 0.22, 1] }}
						style={{ overflow: "hidden" }}
					>
						{children}
					</motion.div>
				)}
			</AnimatePresence>
		</section>
	);
}
