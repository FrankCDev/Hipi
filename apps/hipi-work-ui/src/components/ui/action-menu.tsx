import { CheckIcon } from "lucide-react";
import { ContextMenu, DropdownMenu as DropdownPrimitive } from "radix-ui";
import { type ComponentProps, createContext, type ReactNode, useContext, useRef } from "react";
import { cn } from "../../lib/cn.ts";
import * as Dropdown from "./dropdown-menu.tsx";
import { menuItemClasses, menuRowClasses, menuSurfaceClasses } from "./menu-styles.ts";

export type ActionMenuEntry = "ellipsis" | "context";
export type ActionMenuState = {
	entry: ActionMenuEntry;
	open: boolean;
	contextPosition?: { sideOffset: number; alignOffset: number };
	onOpenChange: (entry: ActionMenuEntry, open: boolean) => void;
};

const Boundary = createContext<ActionMenuState | null>(null);

/** Two native entry mechanisms, one active menu and one action subtree. */
export function ActionMenuBoundary({ state, children }: { state: ActionMenuState; children: ReactNode }) {
	return (
		<Boundary.Provider value={state}>
			<ContextMenu.Root
				open={state.open && state.entry === "context"}
				onOpenChange={(open) => state.onOpenChange("context", open)}
			>
				<DropdownPrimitive.Root
					open={state.open && state.entry === "ellipsis"}
					onOpenChange={(open) => state.onOpenChange("ellipsis", open)}
				>
					{children}
				</DropdownPrimitive.Root>
			</ContextMenu.Root>
		</Boundary.Provider>
	);
}

export const ActionMenuContextTrigger = ContextMenu.Trigger;
export const ActionMenuTrigger = Dropdown.DropdownMenuTrigger;

export function ActionMenu({
	boundary,
	children,
	...props
}: ComponentProps<typeof Dropdown.DropdownMenu> & { boundary?: ActionMenuState }) {
	return boundary ? children : <Dropdown.DropdownMenu {...props}>{children}</Dropdown.DropdownMenu>;
}

export function ActionMenuContent(props: ComponentProps<typeof Dropdown.DropdownMenuContent>) {
	const state = useContext(Boundary);
	const outside = useRef(false);
	const onInteractOutside: NonNullable<ComponentProps<typeof ContextMenu.Content>["onInteractOutside"]> = (event) => {
		props.onInteractOutside?.(event);
		if (!event.defaultPrevented) outside.current = true;
	};
	const onCloseAutoFocus: NonNullable<ComponentProps<typeof ContextMenu.Content>["onCloseAutoFocus"]> = (event) => {
		if (outside.current) event.preventDefault();
		else props.onCloseAutoFocus?.(event);
		outside.current = false;
	};
	const onContextMenu: NonNullable<ComponentProps<typeof ContextMenu.Content>["onContextMenu"]> = (event) => {
		props.onContextMenu?.(event);
		event.stopPropagation();
	};
	if (state?.entry !== "context")
		return (
			<Dropdown.DropdownMenuContent
				{...props}
				onContextMenu={onContextMenu}
				onInteractOutside={onInteractOutside}
				onCloseAutoFocus={onCloseAutoFocus}
			/>
		);
	const { className, side: _side, align: _align, sideOffset: _sideOffset, alignOffset: _alignOffset, ...rest } = props;
	return (
		<ContextMenu.Portal>
			<ContextMenu.Content
				{...rest}
				onContextMenu={onContextMenu}
				onInteractOutside={onInteractOutside}
				onCloseAutoFocus={onCloseAutoFocus}
				data-slot="context-menu-content"
				side="right"
				align="start"
				sideOffset={state.contextPosition?.sideOffset ?? 2}
				alignOffset={state.contextPosition?.alignOffset ?? 0}
				className={cn(menuSurfaceClasses, "ui-context-menu-surface", className)}
			/>
		</ContextMenu.Portal>
	);
}

export function ActionMenuItem(props: ComponentProps<typeof Dropdown.DropdownMenuItem>) {
	const state = useContext(Boundary);
	if (state?.entry !== "context") return <Dropdown.DropdownMenuItem {...props} />;
	const { className, inset, variant = "default", ...rest } = props;
	return (
		<ContextMenu.Item
			{...rest}
			data-slot="context-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(menuRowClasses, menuItemClasses, className)}
		/>
	);
}

export function ActionMenuLabel(props: ComponentProps<typeof Dropdown.DropdownMenuLabel>) {
	const state = useContext(Boundary);
	if (state?.entry !== "context") return <Dropdown.DropdownMenuLabel {...props} />;
	const { className, inset, ...rest } = props;
	return (
		<ContextMenu.Label
			{...rest}
			data-inset={inset}
			className={cn("px-2 py-1.25 font-medium data-[inset]:ps-8", className)}
		/>
	);
}

export function ActionMenuSeparator(props: ComponentProps<typeof Dropdown.DropdownMenuSeparator>) {
	const state = useContext(Boundary);
	if (state?.entry !== "context") return <Dropdown.DropdownMenuSeparator {...props} />;
	return <ContextMenu.Separator {...props} className={cn("mx-2 my-1 h-px bg-border", props.className)} />;
}

export function ActionMenuRadioGroup(props: ComponentProps<typeof Dropdown.DropdownMenuRadioGroup>) {
	const state = useContext(Boundary);
	return state?.entry === "context" ? (
		<ContextMenu.RadioGroup {...props} />
	) : (
		<Dropdown.DropdownMenuRadioGroup {...props} />
	);
}

export function ActionMenuRadioItem(props: ComponentProps<typeof Dropdown.DropdownMenuRadioItem>) {
	const state = useContext(Boundary);
	if (state?.entry !== "context") return <Dropdown.DropdownMenuRadioItem {...props} />;
	const { className, children, ...rest } = props;
	return (
		<ContextMenu.RadioItem {...rest} className={cn(menuRowClasses, className)}>
			{children}
			<span className="pointer-events-none ms-auto flex size-4 shrink-0 items-center justify-center">
				<ContextMenu.ItemIndicator>
					<CheckIcon aria-hidden="true" size={16} />
				</ContextMenu.ItemIndicator>
			</span>
		</ContextMenu.RadioItem>
	);
}
