import {
	type CollisionDetection,
	DndContext,
	type DragMoveEvent,
	DragOverlay,
	MeasuringStrategy,
	type Modifier,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { type AppKeybindings, DEFAULT_APP_KEYBINDINGS, matchesBinding } from "../../../app/keybindings.ts";
import { usePreferences } from "../../../app/preferences.tsx";
import {
	insideSidebar,
	type SidebarDragItem,
	type SidebarDragState,
	type SidebarDrop,
	type SidebarDropCandidate,
	type SidebarPoint,
	sidebarDrop,
} from "./drag-controller.ts";
import { sidebarOrderLabels } from "./order-labels.ts";
import { SidebarPointerSensor, type SidebarPointerSession } from "./pointer-sensor.ts";

type Registration = { item: SidebarDragItem; element: HTMLElement };
type Gesture = { source: SidebarDragItem; owner: HTMLElement; point: SidebarPoint; started: boolean };
type DragContext = {
	state: SidebarDragState;
	disabled: boolean;
	register: (key: string, value: Registration) => () => void;
	begin: (event: ReactPointerEvent<HTMLElement>, item: SidebarDragItem) => boolean;
	keybindings: AppKeybindings;
};
const Context = createContext<DragContext | null>(null);
const idle: SidebarDragState = { source: null, point: null, drop: null };
const keyOf = (item: SidebarDragItem) => `${item.group}:${item.id}`;
const visible = (element: HTMLElement) => element.isConnected && !element.closest("[hidden], [inert]");

/** The overlay follows the pointer; dnd-kit owns measurement and transforms. */
const pointerOffset: Modifier = ({ transform, activatorEvent, activeNodeRect }) => {
	if (!activeNodeRect || !activatorEvent || !("clientX" in activatorEvent) || !("clientY" in activatorEvent))
		return transform;
	if (typeof activatorEvent.clientX !== "number" || typeof activatorEvent.clientY !== "number") return transform;
	return {
		...transform,
		x: transform.x + activatorEvent.clientX - activeNodeRect.left + 12,
		y: transform.y + activatorEvent.clientY - activeNodeRect.top + 12,
	};
};

export function SidebarDragProvider({
	children,
	scrollRef,
	keybindings = DEFAULT_APP_KEYBINDINGS,
	disabled = false,
}: {
	children: ReactNode;
	scrollRef: RefObject<HTMLElement | null>;
	keybindings?: AppKeybindings;
	disabled?: boolean;
}) {
	const entries = useRef(new Map<string, Registration>());
	const gesture = useRef<Gesture | null>(null);
	const sensor = useRef<SidebarPointerSession | null>(null);
	const admission = useRef(disabled);
	const swallowClick = useRef(false);
	const [state, setState] = useState(idle);
	const { locale } = usePreferences();
	const l = sidebarOrderLabels(locale);
	const register = useCallback((key: string, value: Registration) => {
		entries.current.set(key, value);
		return () => {
			if (entries.current.get(key) === value) entries.current.delete(key);
		};
	}, []);
	const valid = useCallback(() => {
		const current = gesture.current;
		if (!current || admission.current) return false;
		const entry = entries.current.get(keyOf(current.source));
		return !!entry && visible(entry.element) && !entry.item.disabled && entry.item.revision === current.source.revision;
	}, []);
	const finish = useCallback((restoreFocus: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		setState(idle);
		if (!current?.started) return;
		swallowClick.current = true;
		if (!restoreFocus || !visible(current.owner)) return;
		const doc = current.owner.ownerDocument;
		// A later dialog/navigation focus owner wins over the pointer gesture.
		if (
			doc.activeElement === doc.body ||
			doc.activeElement === current.owner ||
			current.owner.contains(doc.activeElement)
		)
			current.owner.focus({ preventScroll: true });
	}, []);
	useLayoutEffect(() => {
		admission.current = disabled;
		if (!valid()) sensor.current?.cancel();
	});
	useEffect(() => () => sensor.current?.cancel(), []);
	const sensors = useSensors(
		useSensor(SidebarPointerSensor, {
			activationConstraint: { distance: 6 },
			keybindings,
			isValid: valid,
			onSession: (session) => {
				sensor.current = session;
			},
			onPointer: (point) => {
				if (gesture.current) gesture.current.point = point;
			},
			onFinish: (_outcome, restoreFocus) => finish(restoreFocus),
		}),
	);
	const currentDrop = useCallback(() => {
		const current = gesture.current;
		const viewport = scrollRef.current;
		if (!current || !viewport || !valid()) return null;
		return sidebarDrop(
			current.source,
			current.point,
			[...entries.current.values()]
				.filter(({ element }) => visible(element))
				.map(({ item, element }) => ({ item, rect: element.getBoundingClientRect() })),
			viewport.getBoundingClientRect(),
		);
	}, [scrollRef, valid]);
	const collisionDetection: CollisionDetection = ({ droppableContainers, droppableRects }) => {
		const current = gesture.current;
		const viewport = scrollRef.current;
		if (!current || !viewport || !valid()) return [];
		const candidates: SidebarDropCandidate[] = [];
		for (const container of droppableContainers) {
			const entry = entries.current.get(String(container.id));
			const rect = droppableRects.get(container.id);
			if (entry && rect && visible(entry.element)) candidates.push({ item: entry.item, rect });
		}
		const drop = sidebarDrop(current.source, current.point, candidates, viewport.getBoundingClientRect());
		return drop ? [{ id: `${current.source.group}:${drop.id}`, data: { sidebarDrop: drop } }] : [];
	};
	const updateDrop = (event: DragMoveEvent) => {
		const current = gesture.current;
		if (!current?.started) return;
		const value: unknown = event.collisions?.[0]?.data?.sidebarDrop;
		const drop: SidebarDrop | null =
			value &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string" &&
			"edge" in value &&
			(value.edge === "before" || value.edge === "after") &&
			"before" in value &&
			(typeof value.before === "string" || value.before === null)
				? { id: value.id, edge: value.edge, before: value.before }
				: null;
		setState((previous) =>
			previous.drop?.id === drop?.id && previous.drop?.edge === drop?.edge && previous.drop?.before === drop?.before
				? previous
				: { source: current.source, point: current.point, drop },
		);
	};
	const height = scrollRef.current?.getBoundingClientRect().height ?? 0;
	return (
		<DndContext
			sensors={sensors}
			collisionDetection={collisionDetection}
			measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
			autoScroll={{
				acceleration: 14,
				interval: 16,
				threshold: { x: 0, y: height > 0 ? Math.min(36 / height, 1 / 3) : 0 },
				layoutShiftCompensation: false,
				canScroll: (element) => {
					if (element !== scrollRef.current || !gesture.current || !valid()) return false;
					const rect = element.getBoundingClientRect();
					const point = gesture.current.point;
					// Zero horizontal threshold disables lateral scrolling. Exclude the
					// exact x edges too, where core's zero-width ratio would be undefined.
					return rect.height > 0 && insideSidebar(point, rect) && point.x > rect.left && point.x < rect.right;
				},
			}}
			accessibility={{
				restoreFocus: false,
				screenReaderInstructions: { draggable: l.instructions(keybindings.moveSidebarUp, keybindings.moveSidebarDown) },
				announcements: {
					onDragStart: () => (gesture.current ? l.movingLabel(gesture.current.source.label) : undefined),
					onDragOver: () => undefined,
					onDragEnd: () => undefined, // The durable owner announces success after persistence.
					onDragCancel: () => l.cancelled,
				},
			}}
			onDragStart={() => {
				if (!gesture.current || !valid()) return;
				gesture.current.started = true;
				setState({ source: gesture.current.source, point: gesture.current.point, drop: currentDrop() });
			}}
			onDragMove={updateDrop}
			onDragOver={updateDrop}
			onDragEnd={() => {
				const current = gesture.current;
				const drop = currentDrop(); // Final coordinates/admission, not an earlier render's collision.
				finish(true);
				if (current?.started && drop) current.source.move(drop.before);
			}}
			onDragCancel={() => setState(idle)}
		>
			<Context.Provider
				value={{
					state,
					disabled,
					register,
					keybindings,
					begin: (event, item) => {
						if (
							disabled ||
							gesture.current ||
							item.disabled ||
							event.defaultPrevented ||
							!event.isPrimary ||
							event.button !== 0
						)
							return false;
						if (!(event.target instanceof Element)) return false;
						const owner = event.target.closest<HTMLElement>("button");
						if (!owner || !event.currentTarget.contains(owner)) return false;
						swallowClick.current = false;
						gesture.current = {
							source: { ...item },
							owner,
							point: { x: event.clientX, y: event.clientY },
							started: false,
						};
						return true;
					},
				}}
			>
				<div
					className="sidebar-order-surface"
					data-sidebar-dragging={!!state.source}
					onClickCapture={(event) => {
						if (!swallowClick.current) return;
						swallowClick.current = false;
						if (event.detail === 0) return;
						event.preventDefault();
						event.stopPropagation();
					}}
					onPointerDownCapture={() => {
						if (!gesture.current) swallowClick.current = false;
					}}
				>
					{children}
				</div>
				{typeof document === "undefined"
					? null
					: createPortal(
							<DragOverlay
								dropAnimation={null}
								modifiers={[pointerOffset]}
								style={{ width: "max-content", height: "auto", pointerEvents: "none" }}
								zIndex={1000}
							>
								{state.source ? (
									<div className="sidebar-drag-overlay" aria-hidden="true">
										{state.source.label}
									</div>
								) : null}
							</DragOverlay>,
							document.body,
						)}
			</Context.Provider>
		</DndContext>
	);
}

export function useSidebarDragging(): boolean {
	return !!useContext(Context)?.state.source;
}
export type SidebarOrderAction = {
	item: SidebarDragItem;
	up: string | null | undefined;
	down: string | null | undefined;
};

export function useSidebarSortable(
	action: SidebarOrderAction | undefined,
	register = true,
	suppliedRef?: RefObject<HTMLElement | null>,
) {
	const context = useContext(Context);
	const ownRef = useRef<HTMLElement | null>(null);
	const fallbackId = useId();
	const element = suppliedRef ?? ownRef;
	const key = action ? keyOf(action.item) : fallbackId;
	const disabled = !context || context.disabled || !action || action.item.disabled;
	const draggable = useDraggable({ id: key, disabled });
	const droppable = useDroppable({ id: key, disabled });
	const registerEntry = context?.register;
	useLayoutEffect(() => {
		if (!registerEntry || !action || !element.current || !register) return;
		draggable.setNodeRef(element.current);
		droppable.setNodeRef(element.current);
		const unregister = registerEntry(key, { item: action.item, element: element.current });
		return () => {
			unregister();
			draggable.setNodeRef(null);
			droppable.setNodeRef(null);
		};
	}, [registerEntry, action, register, element, key, draggable.setNodeRef, droppable.setNodeRef]);
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			disabled ||
			!context ||
			!action ||
			context.state.source ||
			event.defaultPrevented ||
			event.repeat ||
			event.nativeEvent.isComposing ||
			event.nativeEvent.keyCode === 229
		)
			return;
		const before = matchesBinding(event, context.keybindings.moveSidebarUp)
			? action.up
			: matchesBinding(event, context.keybindings.moveSidebarDown)
				? action.down
				: undefined;
		if (before === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		action.item.move(before);
	};
	return {
		ref: element,
		describedBy: action ? draggable.attributes["aria-describedby"] : undefined,
		"data-drag-source":
			!!action && context?.state.source?.group === action.item.group && context.state.source.id === action.item.id,
		"data-drag-edge":
			action && context?.state.source?.group === action.item.group && context.state.drop?.id === action.item.id
				? context.state.drop.edge
				: undefined,
		onKeyDown,
		onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
			if (!action || disabled || !draggable.listeners?.onPointerDown || !context?.begin(event, action.item)) return;
			draggable.setActivatorNodeRef(event.target instanceof Element ? event.target.closest("button") : null);
			draggable.listeners.onPointerDown(event);
		},
	};
}
