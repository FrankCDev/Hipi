import type { ReactNode, RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.tsx";
import "./settings-page.css";

/** Shared presentation only; preference, credential and execution owners remain outside. */
export function SettingsSurface({
	open,
	onOpenChange,
	title,
	closeLabel,
	busy = false,
	initialFocus,
	onRestoreFocus,
	onEscapeKeyDown,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	closeLabel: string;
	busy?: boolean;
	initialFocus?: RefObject<HTMLElement | null>;
	onRestoreFocus?: () => void;
	onEscapeKeyDown?: (event: KeyboardEvent) => void;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
			<DialogContent
				className="settings-modal"
				closeLabel={closeLabel}
				closeDisabled={busy}
				aria-describedby={undefined}
				data-settings-surface
				onOpenAutoFocus={(event) => {
					if (initialFocus?.current) {
						event.preventDefault();
						initialFocus.current.focus();
					}
				}}
				onCloseAutoFocus={(event) => {
					if (onRestoreFocus) {
						event.preventDefault();
						onRestoreFocus();
					}
				}}
				onEscapeKeyDown={(event) => {
					if (busy || event.isComposing || event.keyCode === 229) event.preventDefault();
					else onEscapeKeyDown?.(event);
				}}
				onPointerDownOutside={(event) => {
					if (busy) event.preventDefault();
				}}
			>
				<header className="settings-modal-header">
					<DialogTitle>{title}</DialogTitle>
				</header>
				{children}
			</DialogContent>
		</Dialog>
	);
}
