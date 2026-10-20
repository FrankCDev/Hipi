import { type Activators, PointerSensor, type PointerSensorOptions, type SensorProps } from "@dnd-kit/core";
import { type AppKeybindings, matchesBinding } from "../../app/keybindings.ts";
import type { SidebarPoint } from "./sidebar-drag-controller.ts";

export type SidebarPointerSession = { cancel: () => void };
export interface SidebarPointerSensorOptions extends PointerSensorOptions {
	keybindings: AppKeybindings;
	onSession: (session: SidebarPointerSession | null) => void;
	onPointer: (point: SidebarPoint) => void;
	onFinish: (outcome: "end" | "cancel", restoreFocus: boolean) => void;
	isValid: () => boolean;
}

const activationConstraint = { distance: 6 };

/**
 * Public dnd-kit Sensor extension for sidebar pointer ownership and cancellation.
 * DndContext owns drag state, measurements, overlays, and automatic scrolling;
 * the provider scopes click/selection suppression to its own sidebar surface.
 * Core's built-in PointerSensor cannot filter pointer identity or expose owned
 * cancellation, so this adapter supplies only input admission and its lifecycle.
 */
export class SidebarPointerSensor {
	static activators: Activators<SidebarPointerSensorOptions> = PointerSensor.activators;
	readonly autoScrollEnabled = true;

	constructor(props: SensorProps<SidebarPointerSensorOptions>) {
		const { options, event } = props;
		const doc = props.activeNode.node.current?.ownerDocument;
		const view = doc?.defaultView;
		if (
			!doc ||
			!view ||
			!("pointerId" in event) ||
			typeof event.pointerId !== "number" ||
			!("clientX" in event) ||
			typeof event.clientX !== "number" ||
			!("clientY" in event) ||
			typeof event.clientY !== "number"
		) {
			props.onAbort(props.active);
			props.onCancel();
			options.onSession(null);
			options.onFinish("cancel", false);
			return;
		}
		const pointerId = event.pointerId;
		const origin = { x: event.clientX, y: event.clientY };
		let closed = false;
		let activated = false;
		let frame = 0;
		const finish = (outcome: "end" | "cancel", restoreFocus = false) => {
			if (closed) return;
			closed = true;
			view.cancelAnimationFrame(frame);
			doc.removeEventListener("pointermove", move);
			doc.removeEventListener("pointerup", up);
			doc.removeEventListener("pointercancel", lostPointer);
			doc.removeEventListener("lostpointercapture", lostPointer);
			doc.removeEventListener("pointerout", leave);
			doc.removeEventListener("visibilitychange", visibility);
			doc.removeEventListener("keydown", keydown);
			view.removeEventListener("blur", cancelWindow);
			view.removeEventListener("resize", cancelWindow);
			options.onSession(null);
			try {
				if (!activated) props.onAbort(props.active);
			} finally {
				try {
					if (outcome === "end") props.onEnd();
					else props.onCancel();
				} finally {
					options.onFinish(outcome, outcome === "end" ? activated : restoreFocus);
				}
			}
		};
		const observe = (next: PointerEvent) => {
			if (closed || next.pointerId !== pointerId) return false;
			if (!options.isValid()) {
				finish("cancel");
				return false;
			}
			if (closed) return false;
			options.onPointer({ x: next.clientX, y: next.clientY });
			if (!closed && !options.isValid()) finish("cancel");
			return !closed;
		};
		const move = (next: PointerEvent) => {
			if (closed || next.pointerId !== pointerId) return;
			if (next.buttons === 0) {
				finish("cancel");
				return;
			}
			if (!observe(next)) return;
			const point = { x: next.clientX, y: next.clientY };
			if (!activated) {
				const offset = { x: origin.x - point.x, y: origin.y - point.y };
				if (Math.hypot(offset.x, offset.y) <= activationConstraint.distance) {
					props.onPending(props.active, activationConstraint, origin, offset);
					return;
				}
				activated = true;
				props.onStart(origin);
			}
			// Core starts from the origin; publish this same activating move so
			// DndContext's overlay and collision geometry immediately catch up.
			if (!closed) props.onMove(point);
			if (next.cancelable) next.preventDefault();
		};
		const up = (next: PointerEvent) => {
			if (observe(next)) finish("end");
		};
		const lostPointer = (next: PointerEvent) => {
			if (next.pointerId === pointerId) finish("cancel");
		};
		const leave = (next: PointerEvent) => {
			if (next.pointerId === pointerId && next.relatedTarget === null) finish("cancel");
		};
		const visibility = () => {
			if (doc.hidden) finish("cancel");
		};
		// A new gesture must measure a resized viewport before deriving its
		// bounded autoscroll edge zone, matching the stock sensor's lifecycle.
		const cancelWindow = () => finish("cancel");
		const keydown = (next: KeyboardEvent) => {
			if (
				next.defaultPrevented ||
				next.isComposing ||
				next.keyCode === 229 ||
				!matchesBinding(next, options.keybindings.cancelSidebarMove)
			)
				return;
			next.preventDefault();
			next.stopPropagation();
			finish("cancel", true);
		};
		const validate = () => {
			if (closed) return;
			if (!options.isValid()) {
				finish("cancel");
				return;
			}
			if (!closed) frame = view.requestAnimationFrame(validate);
		};
		doc.addEventListener("pointermove", move, { passive: false });
		doc.addEventListener("pointerup", up);
		doc.addEventListener("pointercancel", lostPointer);
		doc.addEventListener("lostpointercapture", lostPointer);
		doc.addEventListener("pointerout", leave);
		doc.addEventListener("visibilitychange", visibility);
		doc.addEventListener("keydown", keydown);
		view.addEventListener("blur", cancelWindow);
		view.addEventListener("resize", cancelWindow);
		options.onPointer(origin);
		options.onSession({ cancel: () => finish("cancel") });
		if (!closed) props.onPending(props.active, activationConstraint, origin);
		validate();
	}
}
