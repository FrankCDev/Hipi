import { Slot } from "radix-ui";
import {
	type ComponentProps,
	createContext,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

const ProviderContext = createContext<boolean | null>(null);

/** Keep tooltip metadata out of the child primitive's state and slot namespace. */
function ActionTooltipTarget({
	"data-state": tooltipState,
	"data-slot": _tooltipSlot,
	...props
}: ComponentProps<typeof Slot.Root> & { "data-state"?: string; "data-slot"?: string }) {
	return <Slot.Root {...props} data-tooltip-state={tooltipState} />;
}

/** One warm delay budget for related controls; standalone consumers remain supported. */
export function ActionTooltipProvider({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
	return (
		<ProviderContext.Provider value={disabled}>
			<TooltipProvider>{children}</TooltipProvider>
		</ProviderContext.Provider>
	);
}

export function ActionTooltip({
	children,
	label,
	shortcut,
	disabled = false,
	side = "top",
}: {
	children: ReactElement;
	label: string;
	shortcut?: string;
	disabled?: boolean;
	side?: "top" | "right" | "bottom" | "left";
}) {
	const inherited = useContext(ProviderContext);
	const [open, setOpen] = useState(false);
	const interactionAllowed = useRef(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const wasBlocked = useRef(false);
	const blocked = disabled || inherited === true;
	useEffect(() => {
		if (blocked && !wasBlocked.current) {
			interactionAllowed.current = false;
			// Radix controlled open does not cancel a pending delay. Retire its pointer
			// interaction without remounting the trigger or moving keyboard focus.
			const node = trigger.current;
			node?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: node.parentElement }));
			setOpen(false);
		}
		wasBlocked.current = blocked;
	}, [blocked]);
	const content = (
		<Tooltip
			disableHoverableContent={blocked}
			open={open}
			onOpenChange={(value) => setOpen(value && !blocked && interactionAllowed.current)}
		>
			<TooltipTrigger
				asChild
				data-action-tooltip-trigger=""
				ref={trigger}
				onPointerMoveCapture={() => {
					interactionAllowed.current = !blocked;
				}}
				onPointerMove={(event) => {
					if (blocked) event.preventDefault();
				}}
				onFocus={(event) => {
					if (!interactionAllowed.current) event.preventDefault();
				}}
				onFocusCapture={(event) => {
					// Focus restored after a pointer action is not a fresh keyboard request.
					interactionAllowed.current = !blocked && event.currentTarget.matches(":focus-visible");
				}}
			>
				<ActionTooltipTarget>{children}</ActionTooltipTarget>
			</TooltipTrigger>
			{!blocked ? (
				<TooltipContent side={side}>
					<span>{label}</span>
					{shortcut ? (
						<>
							{" "}
							<kbd>{shortcut}</kbd>
						</>
					) : null}
				</TooltipContent>
			) : null}
		</Tooltip>
	);
	return inherited === null ? <ActionTooltipProvider>{content}</ActionTooltipProvider> : content;
}
