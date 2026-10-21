import type { Scope } from "@hipi/work-runtime/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { NavigationWindow } from "./navigation-query.ts";
import { isNavigationWindowKey } from "./query-keys.ts";
import type { RecentWindow } from "./window-query.ts";

function usable(element: HTMLElement) {
	return (
		element.isConnected &&
		!element.closest('[hidden], [inert], [aria-hidden="true"]') &&
		!element.matches(':disabled, [aria-disabled="true"], [aria-haspopup]:not([aria-haspopup="false"])') &&
		element.getClientRects().length > 0 &&
		element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== "hidden"
	);
}

/** Require both completed cache reads and their actual DOM commit, not a guessed frame. */
export function navigationFocusSettled(root: HTMLElement, cache: QueryClient, scope: Scope) {
	const regions = Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-query]")).filter((region) =>
		usable(region),
	);
	return cache
		.getQueryCache()
		.findAll({
			predicate: (query) => isNavigationWindowKey(query.queryKey),
		})
		.every((query) => {
			const view = query.queryKey[1];
			if (!query.isActive() || !view || typeof view !== "object" || !("kind" in view)) return true;
			if (view.kind === "workspace" && (!("workspaceId" in view) || view.workspaceId !== scope.workspaceId))
				return true;
			const region = regions.find((region) => region.dataset.sidebarQuery === JSON.stringify(query.queryKey));
			if (!region) return true;
			const window = cache.getQueryData<NavigationWindow | RecentWindow>(query.queryKey);
			return (
				query.state.fetchStatus !== "fetching" &&
				Number(region.dataset.sidebarUpdatedAt) === query.state.dataUpdatedAt &&
				(query.state.status === "error" ||
					(!query.state.isInvalidated &&
						window?.pages[0]?.coverage.state === "ready" &&
						!("rebuilding" in window && window.rebuilding) &&
						!("refreshPaused" in window && window.refreshPaused) &&
						!("unpublished" in window && window.unpublished)))
			);
		});
}

/** Project metadata must also reach its visible list DOM before focus intent can settle. */
export function projectFocusSettled(root: HTMLElement, cache: QueryClient) {
	const regions = Array.from(root.querySelectorAll<HTMLElement>("[data-project-query]")).filter(usable);
	return cache
		.getQueryCache()
		.findAll({ queryKey: ["projects"] })
		.every((query) => {
			if (!query.isActive()) return true;
			const region = regions.find((region) => region.dataset.projectQuery === JSON.stringify(query.queryKey));
			if (!region) return true;
			return (
				query.state.fetchStatus !== "fetching" &&
				Number(region.dataset.projectUpdatedAt) === query.state.dataUpdatedAt &&
				(query.state.status === "error" || !query.state.isInvalidated)
			);
		});
}

/** Owns only focus lost when a pinned shortcut disappears, never route selection. */
export class PinFocusRecovery {
	#cleanup: (() => void) | undefined;

	cancel() {
		this.#cleanup?.();
		this.#cleanup = undefined;
	}

	restore(scope: Scope, root: HTMLElement, fallback: HTMLElement, waitForRow: boolean, settled: () => boolean) {
		this.#restore(
			() =>
				Array.from(root.querySelectorAll<HTMLButtonElement>(".conversation-link")).find(
					(item) =>
						item.dataset.workspaceId === scope.workspaceId &&
						item.dataset.conversationId === scope.conversationId &&
						item.dataset.sidebarLocation !== "pinned" &&
						usable(item),
				),
			root,
			fallback,
			waitForRow,
			settled,
		);
	}
	restoreProject(
		projectId: string,
		root: HTMLElement,
		fallback: HTMLElement,
		waitForRow: boolean,
		settled: () => boolean,
	) {
		this.#restore(
			() =>
				Array.from(root.querySelectorAll<HTMLButtonElement>(".project-open")).find(
					(item) =>
						item.closest<HTMLElement>("[data-project-id]")?.dataset.projectId === projectId &&
						!item.closest("[data-pinned-project]") &&
						usable(item),
				),
			root,
			fallback,
			waitForRow,
			settled,
		);
	}
	#restore(
		target: () => HTMLButtonElement | undefined,
		root: HTMLElement,
		fallback: HTMLElement,
		waitForRow: boolean,
		settled: () => boolean,
	) {
		this.cancel();
		if (!usable(root) || !usable(fallback)) return;
		const document = root.ownerDocument;
		const current = target();
		if (current) {
			current.focus({ preventScroll: true });
			return;
		}
		fallback.focus({ preventScroll: true });
		if (!waitForRow || document.activeElement !== fallback || !usable(root) || settled()) return;
		const cancel = () => this.cancel();
		const focus = (event: FocusEvent) => {
			if (event.target !== fallback) this.cancel();
		};
		const observer = new MutationObserver(() => {
			if (!usable(root) || !usable(fallback) || document.activeElement !== fallback) {
				this.cancel();
				return;
			}
			const row = target();
			if (!row) {
				if (settled()) this.cancel();
				return;
			}
			this.cancel();
			row.focus({ preventScroll: true });
		});
		this.#cleanup = () => {
			observer.disconnect();
			document.removeEventListener("pointerdown", cancel, true);
			document.removeEventListener("keydown", cancel, true);
			document.removeEventListener("focusin", focus, true);
			document.defaultView?.removeEventListener("blur", cancel);
		};
		document.addEventListener("pointerdown", cancel, true);
		document.addEventListener("keydown", cancel, true);
		document.addEventListener("focusin", focus, true);
		document.defaultView?.addEventListener("blur", cancel);
		observer.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"hidden",
				"inert",
				"aria-hidden",
				"disabled",
				"aria-disabled",
				"class",
				"style",
				"data-sidebar-updated-at",
				"data-project-updated-at",
				"data-sidebar-fetching",
			],
		});
	}
}
