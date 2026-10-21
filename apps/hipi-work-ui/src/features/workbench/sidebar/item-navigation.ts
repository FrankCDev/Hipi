import { type AppKeybindings, matchesBinding } from "../../../app/keybindings.ts";

const itemSelector = "[data-sidebar-cycle-item]";
const modalSelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
type Modifiers = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;
type Sequence = {
	row: HTMLElement;
	rows: HTMLElement[];
	visited: Set<HTMLElement>;
	modifiers: Modifiers | null;
};

function eligible(element: HTMLElement) {
	return (
		element.isConnected &&
		!element.closest('[inert], [hidden], [aria-hidden="true"]') &&
		!element.matches(':disabled, [aria-disabled="true"], [aria-haspopup]:not([aria-haspopup="false"])') &&
		element.getClientRects().length > 0 &&
		element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== "hidden"
	);
}

/** Mounted navigation items only. This owner never fetches rows or changes focus. */
export class SidebarItemNavigation {
	private sequence: Sequence | null = null;
	private frame: number | undefined;
	private readonly root: HTMLElement;
	private readonly bindings: AppKeybindings;
	private readonly enabled: () => boolean;
	private readonly isMac: boolean;

	constructor(root: HTMLElement, bindings: AppKeybindings, enabled: () => boolean, isMac: boolean) {
		this.root = root;
		this.bindings = bindings;
		this.enabled = enabled;
		this.isMac = isMac;
	}

	reset = () => {
		this.sequence = null;
		if (this.frame !== undefined) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
		this.frame = undefined;
	};

	keyUp = (event: KeyboardEvent) => {
		const sequence = this.sequence;
		const held = sequence?.modifiers;
		if (!sequence || !held) return;
		if (
			(held.altKey && !event.altKey) ||
			(held.ctrlKey && !event.ctrlKey) ||
			(held.metaKey && !event.metaKey) ||
			(held.shiftKey && !event.shiftKey)
		) {
			sequence.modifiers = null;
			if (sequence.row.getAttribute("aria-current") === "page") this.reset();
			else
				sequence.visited = new Set(
					[...sequence.visited].filter((row) => row === sequence.row || row.getAttribute("aria-current") === "page"),
				);
		}
	};

	keyDown = (event: KeyboardEvent) => {
		const target = event.target;
		if (
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.shiftKey &&
			(event.key === "Enter" || event.key === " ") &&
			target instanceof Element &&
			this.root.contains(target) &&
			target.matches(itemSelector)
		)
			this.reset();
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph"))
			return;
		const direction =
			matchesBinding(event, this.bindings.previousSidebarItem, this.isMac) ||
			matchesBinding(event, this.bindings.previousSidebarItemAlternate, this.isMac)
				? -1
				: matchesBinding(event, this.bindings.nextSidebarItem, this.isMac) ||
						matchesBinding(event, this.bindings.nextSidebarItemAlternate, this.isMac)
					? 1
					: 0;
		if (!direction) return;
		if (!this.enabled() || !eligible(this.root) || this.root.ownerDocument.querySelector(modalSelector)) {
			this.reset();
			return;
		}
		// A configurable plain/Option character must not consume text entry. The
		// default primary-modifier shortcuts still work from the composer.
		if (
			!event.ctrlKey &&
			!event.metaKey &&
			target instanceof Element &&
			target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		)
			return;
		const rows = Array.from(this.root.querySelectorAll<HTMLElement>(itemSelector)).filter(eligible);
		const current = rows.findLast((row) => row.getAttribute("aria-current") === "page");
		if (this.sequence && this.sequence.row === current && !event.repeat && !this.sequence.modifiers)
			this.sequence = null;
		const previous = this.sequence;
		const continuing = previous && rows.includes(previous.row) && (!current || previous.visited.has(current));
		const anchor = continuing ? previous.row : current;
		const sameMembers =
			continuing && rows.length === previous.rows.length && previous.rows.every((row) => rows.includes(row));
		const order = sameMembers ? previous.rows : rows;
		const index = anchor ? order.indexOf(anchor) : -1;
		const next = order[index < 0 ? (direction > 0 ? 0 : order.length - 1) : index + direction];
		event.preventDefault();
		if (!next) return;
		const visited = continuing ? previous.visited : new Set<HTMLElement>();
		if (current) visited.add(current);
		visited.add(next);
		this.sequence = {
			row: next,
			rows: order,
			visited,
			modifiers:
				event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
					? { altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }
					: null,
		};
		next.click();
		const view = this.root.ownerDocument.defaultView;
		if (!view) return;
		if (this.frame !== undefined) view.cancelAnimationFrame(this.frame);
		this.frame = view.requestAnimationFrame(() => {
			this.frame = undefined;
			if (!this.enabled() || !this.root.contains(next) || !eligible(next)) return;
			for (let parent = next.parentElement; parent && this.root.contains(parent); parent = parent.parentElement) {
				const style = view.getComputedStyle(parent);
				if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
				const rect = parent.getBoundingClientRect();
				const scale = rect.height / parent.offsetHeight;
				if (!Number.isFinite(scale) || scale <= 0) return;
				const row = next.getBoundingClientRect();
				const top = (row.top - rect.top) / scale - parent.clientTop;
				const above = top - (Number.parseFloat(style.scrollPaddingTop) || 0);
				const below =
					top + row.height / scale - parent.clientHeight + (Number.parseFloat(style.scrollPaddingBottom) || 0);
				const offset =
					above < 0 && below < 0 ? Math.max(above, below) : above > 0 && below > 0 ? Math.min(above, below) : 0;
				if (offset) parent.scrollTo({ top: parent.scrollTop + offset, behavior: "instant" });
				return;
			}
		});
	};

	attach() {
		const doc = this.root.ownerDocument;
		const view = doc.defaultView;
		doc.addEventListener("pointerdown", this.reset, true);
		view?.addEventListener("keydown", this.keyDown);
		view?.addEventListener("keyup", this.keyUp);
		view?.addEventListener("blur", this.reset);
		return () => {
			this.reset();
			doc.removeEventListener("pointerdown", this.reset, true);
			view?.removeEventListener("keydown", this.keyDown);
			view?.removeEventListener("keyup", this.keyUp);
			view?.removeEventListener("blur", this.reset);
		};
	}
}
