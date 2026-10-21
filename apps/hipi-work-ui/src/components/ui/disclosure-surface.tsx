import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, usePresence } from "framer-motion";
import {
	type ComponentPropsWithRef,
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { disclosureTransition } from "./disclosure-motion.ts";

const Availability = createContext({ reduced: false, entering: false, complete: () => {} });

/** Retains an exiting body only until Motion and any live descendant presence owners finish. */
export function DisclosureSurface({
	expanded,
	reduced,
	children,
	inert,
	"aria-hidden": ariaHidden,
	...props
}: Omit<ComponentPropsWithRef<"section">, "hidden"> & { expanded: boolean; reduced: boolean }) {
	const parentPresent = useIsPresent();
	const visible = expanded && parentPresent;
	const [settled, setSettled] = useState(!visible);
	const currentVisible = useRef(visible);
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
		currentVisible.current = visible;
		if (visible) setSettled(false);
	}, [visible]);
	const complete = () => {
		if (!currentVisible.current) setSettled(true);
	};
	return (
		<section {...props} hidden={!visible && settled} inert={!visible || inert} aria-hidden={!visible || ariaHidden}>
			<Availability.Provider value={{ reduced, entering: mounted.current, complete }}>
				{/* Nested disclosure exits must keep descendant draft/dialog presence owners alive. */}
				<AnimatePresence initial={false} propagate onExitComplete={complete}>
					{visible && <DisclosureBody key="body">{children}</DisclosureBody>}
				</AnimatePresence>
			</Availability.Provider>
		</section>
	);
}

function DisclosureBody({ children }: { children: ReactNode }) {
	const [present, safeToRemove] = usePresence();
	const { reduced, entering, complete } = useContext(Availability);
	const content = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number>();
	const animatedHeight = useMotionValue<number | string>(entering && !reduced ? 0 : "auto");
	const opacity = useMotionValue(entering && !reduced ? 0 : 1);
	const completion = useRef(complete);
	useLayoutEffect(() => {
		completion.current = complete;
	});
	useLayoutEffect(() => {
		const node = content.current;
		if (!node || !present) return;
		const measure = () => {
			// Hidden ancestors report zero without a layout box. Do not replace the
			// last natural height with that value; a visible empty body may be zero.
			if (node.getClientRects().length) setHeight(node.getBoundingClientRect().height);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [present]);
	useLayoutEffect(() => {
		// Wait for a visible natural box before entering. Animating a MotionValue
		// through "auto" would jump instead of interpolating its numeric height.
		if (present && height === undefined) return;
		if (typeof animatedHeight.get() !== "number") animatedHeight.set(height ?? 0);
		let active = true;
		const transition = reduced ? { duration: 0 } : disclosureTransition;
		const resize = animate(animatedHeight, present ? (height ?? 0) : 0, transition);
		const fade = animate(opacity, present ? 1 : 0, transition);
		void Promise.all([resize, fade]).then(() => {
			if (active && !present) {
				completion.current();
				safeToRemove?.();
			}
		});
		return () => {
			active = false;
			resize.stop();
			fade.stop();
		};
	}, [animatedHeight, height, opacity, present, reduced, safeToRemove]);
	return (
		<motion.div data-disclosure-motion="" style={{ overflow: "hidden", height: animatedHeight, opacity }}>
			<div ref={content} data-disclosure-content="">
				{children}
			</div>
		</motion.div>
	);
}
