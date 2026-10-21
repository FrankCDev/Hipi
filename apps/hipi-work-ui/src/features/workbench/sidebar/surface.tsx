import { animate, type MotionStyle, type MotionValue, motion, useMotionValue, useTransform } from "framer-motion";
import { type ComponentProps, type ReactNode, type Ref, useLayoutEffect, useSyncExternalStore } from "react";
import { type ThemeConfig, useThemeSettings } from "../../../app/theme/index.ts";

/** One shared progress value keeps reserved layout and content motion synchronized. */
export const sidebarSurfaceMotion = { type: "spring", duration: 0.3, bounce: 0.1 } as const;
export function sidebarSurfaceProgress(value: number) {
	return Math.min(1, Math.max(0, value));
}
const systemMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const serverMotion = () => false;
function subscribeMotion(changed: () => void) {
	const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
	media?.addEventListener("change", changed);
	return () => media?.removeEventListener("change", changed);
}

/** The inner width never measures the animated outer width or writes a width preference. */
export function SidebarSurface({
	children,
	ref,
	id,
	label,
	collapsed,
	narrow,
	inert,
	reducedMotion,
}: {
	children: ReactNode;
	ref: Ref<HTMLElement>;
	id: string;
	label: string;
	collapsed: boolean;
	narrow: boolean;
	inert: boolean;
	reducedMotion: ThemeConfig["reducedMotion"];
}) {
	const systemReduced = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
	const reduced = reducedMotion === "on" || (reducedMotion === "system" && systemReduced);
	const target = narrow || !collapsed ? 1 : 0;
	const progress = useMotionValue(target);
	const width = useTransform(progress, (value) => `calc(var(--sidebar-width) * ${sidebarSurfaceProgress(value)})`);
	const opacity = useTransform(progress, sidebarSurfaceProgress);
	const style: MotionStyle & { "--sidebar-progress": MotionValue<number> } = { width, "--sidebar-progress": opacity };
	useLayoutEffect(() => {
		if (reduced || narrow) {
			progress.set(target);
			return;
		}
		const animation = animate(progress, target, sidebarSurfaceMotion);
		return () => animation.stop();
	}, [narrow, progress, reduced, target]);
	return (
		<motion.div className="sidebar-surface" style={style} data-sidebar-surface="">
			<aside
				ref={ref}
				className="sidebar"
				data-sidebar-navigation-root=""
				id={id}
				aria-label={label}
				aria-hidden={inert || undefined}
				inert={inert}
			>
				{children}
			</aside>
		</motion.div>
	);
}

/** Connect appearance at the surface boundary, not the navigation state owner. */
export function SidebarNavigationSurface(props: Omit<ComponentProps<typeof SidebarSurface>, "reducedMotion">) {
	const { config } = useThemeSettings();
	return <SidebarSurface {...props} reducedMotion={config.reducedMotion} />;
}
