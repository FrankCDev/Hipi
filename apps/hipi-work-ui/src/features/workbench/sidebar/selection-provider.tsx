import type { Scope } from "@hipi/work-runtime/contracts";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { resolveSidebarAlias, type SidebarLocation } from "./selection-owner.ts";

type Alias = { id: string; location: SidebarLocation; element: HTMLButtonElement; observer?: MutationObserver };
const visibilityAttributes = ["hidden", "inert", "aria-hidden", "disabled", "aria-disabled", "class", "style"];

/** Only current-route aliases register. This owner never navigates or moves focus. */
export class SidebarAliasRegistry {
	readonly scope: Scope;
	readonly #root: RefObject<HTMLElement | null>;
	readonly #aliases = new Map<string, Alias>();
	readonly #listeners = new Set<() => void>();
	#preferred: SidebarLocation | null;
	// A registered identity can survive an all-hidden interval. It is not evidence
	// of a visible highlight, and never replaces an eligible fallback.
	#active: string | null = null;
	#window: Window | null = null;
	constructor(scope: Scope, preferred: SidebarLocation | null, root: RefObject<HTMLElement | null>) {
		this.scope = scope;
		this.#preferred = preferred;
		this.#root = root;
	}
	getSnapshot = () => this.#active;
	getServerSnapshot = () => null;
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	setPreferred(location: SidebarLocation | null) {
		this.#preferred = location;
		this.reconcile();
	}
	register(id: string, location: SidebarLocation, element: HTMLButtonElement) {
		this.#aliases.get(id)?.observer?.disconnect();
		const alias: Alias = { id, location, element };
		this.#aliases.set(id, alias);
		this.#watch(alias);
		if (!this.#window) {
			this.#window = element.ownerDocument.defaultView;
			this.#window?.addEventListener("resize", this.reconcile);
		}
		this.reconcile();
		return () => {
			alias.observer?.disconnect();
			if (this.#aliases.get(id) !== alias) return;
			this.#aliases.delete(id);
			if (!this.#aliases.size) {
				this.#window?.removeEventListener("resize", this.reconcile);
				this.#window = null;
			}
			this.reconcile();
		};
	}
	#watch(alias: Alias) {
		alias.observer?.disconnect();
		const root = this.#root.current;
		if (!root?.contains(alias.element)) return;
		alias.observer = new MutationObserver(() => {
			if (this.#aliases.get(alias.id) !== alias) return;
			// Reparenting can change the exact ancestor chain while preserving the row.
			this.#watch(alias);
			this.reconcile();
		});
		for (let node: HTMLElement | null = alias.element; node; node = node.parentElement) {
			alias.observer.observe(node, { attributes: true, attributeFilter: visibilityAttributes, childList: true });
		}
	}
	reconcile = () => {
		const root = this.#root.current;
		const ordered = [...this.#aliases.values()].sort((left, right) => {
			const position = left.element.compareDocumentPosition(right.element);
			return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
		});
		const active = resolveSidebarAlias(
			ordered.map(({ id, location, element }) => ({
				id,
				location,
				eligible:
					!!root?.contains(element) &&
					element.isConnected &&
					!element.closest('[inert], [hidden], [aria-hidden="true"]') &&
					!element.matches(':disabled, [aria-disabled="true"], [aria-haspopup]:not([aria-haspopup="false"])') &&
					element.getClientRects().length > 0 &&
					element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== "hidden",
			})),
			this.#preferred,
			this.#active,
		);
		if (active === this.#active) return;
		this.#active = active;
		for (const listener of this.#listeners) listener();
	};
	clear() {
		for (const alias of this.#aliases.values()) alias.observer?.disconnect();
		this.#aliases.clear();
		this.#window?.removeEventListener("resize", this.reconcile);
		this.#window = null;
		this.reconcile();
	}
}

const SelectionContext = createContext<SidebarAliasRegistry | null>(null);

export function SidebarSelectionProvider({
	scope,
	preferredLocation,
	rootRef,
	children,
}: {
	scope: Scope;
	preferredLocation: SidebarLocation | null;
	rootRef: RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const { workspaceId, conversationId } = scope;
	// Changing the canonical route retires its registry, never its execution owner.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Preference updates reconcile the existing route registry below.
	const registry = useMemo(
		() => new SidebarAliasRegistry({ workspaceId, conversationId }, preferredLocation, rootRef),
		[workspaceId, conversationId, rootRef],
	);
	useLayoutEffect(() => {
		registry.setPreferred(preferredLocation);
	}, [registry, preferredLocation]);
	useLayoutEffect(() => () => registry.clear(), [registry]);
	return <SelectionContext.Provider value={registry}>{children}</SelectionContext.Provider>;
}

export function useSidebarAlias(scope: Scope, location: SidebarLocation) {
	const registry = useContext(SelectionContext);
	if (!registry) throw new Error("Sidebar aliases require their navigation provider");
	const id = useId();
	const ref = useRef<HTMLButtonElement>(null);
	const routeOwner =
		!!scope.conversationId &&
		registry.scope.workspaceId === scope.workspaceId &&
		registry.scope.conversationId === scope.conversationId;
	const kind = location.kind;
	const workspaceId = location.kind === "workspace" ? location.workspaceId : undefined;
	const projectId = location.kind === "project" ? location.projectId : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: The typed location is identified by its discriminant and identity, not caller object identity.
	useLayoutEffect(() => {
		if (!routeOwner || !ref.current) return;
		return registry.register(id, location, ref.current);
	}, [registry, id, routeOwner, kind, workspaceId, projectId]);
	const active = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getServerSnapshot);
	return { ref, active: routeOwner && active === id };
}
