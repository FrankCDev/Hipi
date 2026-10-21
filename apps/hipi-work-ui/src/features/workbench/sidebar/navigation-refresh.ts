import { type AppClient, AppError, type SidebarCoverage } from "@hipi/work-runtime/contracts";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import type { NavigationWindow } from "./navigation-query.ts";
import type { RecentWindow } from "./window-query.ts";

export const navigationProbeOptions = (client: AppClient, logical = false) =>
	queryOptions({
		queryKey: logical ? ["sidebar-navigation-probe", "logical"] : ["sidebar-navigation-probe"],
		queryFn: ({ signal }) =>
			client.call(
				"listSidebarConversations",
				{ view: logical ? { kind: "project_recent" } : { kind: "recent" } },
				signal,
			),
		retry: false,
	});

export function sameNavigationPublication(a: SidebarCoverage, b: SidebarCoverage) {
	return (
		a.generation === b.generation &&
		a.membershipGeneration === b.membershipGeneration &&
		a.projectMembershipGeneration === b.projectMembershipGeneration &&
		a.projectOrderGeneration === b.projectOrderGeneration
	);
}

export function reconcileNavigationPublication(cache: QueryClient, coverage: SidebarCoverage, now = Date.now()) {
	return cache.invalidateQueries(
		{
			predicate: (query) => {
				if (query.queryKey[0] !== "sidebar-navigation" && query.queryKey[0] !== "sidebar-window") return false;
				if (!query.isActive() || query.state.fetchStatus === "fetching") return false;
				if (query.state.error instanceof AppError && query.state.error.code === "STORE_MISMATCH") return false;
				const window = cache.getQueryData<NavigationWindow | RecentWindow>(query.queryKey);
				const published = window?.pages[0]?.coverage;
				if (query.state.error && now - query.state.errorUpdatedAt < 10000) return false;
				return (
					!!query.state.error ||
					// A first building page has no rows, but publication retains its generation.
					// Read the published rows before treating that cached page as complete.
					(published?.state === "building" && coverage.state !== "building") ||
					(!!window &&
						(("rebuilding" in window && window.rebuilding) || ("unpublished" in window && window.unpublished)) &&
						coverage.state !== "building") ||
					(!!published && !sameNavigationPublication(published, coverage))
				);
			},
		},
		{ cancelRefetch: false },
	);
}

/** Existing command/activity owners publish cache changes; this bridge never owns their commands. */
export function watchNavigationSignals(cache: QueryClient) {
	const values = new Map<string, unknown>();
	return cache.getQueryCache().subscribe((event) => {
		if (event.type === "removed") values.delete(event.query.queryHash);
		if (event.type !== "updated") return;
		const root = event.query.queryKey[0];
		const catalog =
			root === "projects" ||
			root === "project-catalog" ||
			root === "workspaces" ||
			root === "conversations" ||
			root === "pinned-conversations" ||
			root === "sidebar-pins" ||
			root === "conversation-presentation";
		const activity =
			root === "receipt" || root === "conversation-model" || root === "conversation" || root === "workspace";
		if (catalog && event.action.type !== "invalidate") return;
		if (activity) {
			if (event.action.type !== "success" || values.get(event.query.queryHash) === event.query.state.data) return;
			values.set(event.query.queryHash, event.query.state.data);
		}
		if (!catalog && !activity) return;
		void cache.invalidateQueries({ queryKey: ["sidebar-navigation"] }, { cancelRefetch: false });
		void cache.invalidateQueries({ queryKey: ["sidebar-window"] }, { cancelRefetch: false });
		void cache.invalidateQueries({ queryKey: ["sidebar-navigation-probe"] }, { cancelRefetch: false });
	});
}

/** One visible-sidebar probe detects publication, without rereading every branch every tick. */
export function useNavigationRefresh(visible: boolean, logical = false) {
	const cache = useQueryClient();
	const client = useAppClient();
	const [documentVisible, setDocumentVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const update = () => setDocumentVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	const active = visible && documentVisible;
	const probe = useQuery({
		...navigationProbeOptions(client, logical),
		enabled: active,
		refetchInterval: (query) =>
			active && !(query.state.error instanceof AppError && query.state.error.code === "STORE_MISMATCH")
				? query.state.error
					? 10000
					: 2000
				: false,
	});
	useEffect(() => {
		const coverage = probe.data?.coverage;
		if (!active || !coverage) return;
		void reconcileNavigationPublication(cache, coverage, probe.dataUpdatedAt);
	}, [cache, active, probe.data, probe.dataUpdatedAt]);
	useEffect(() => {
		if (!active) {
			void cache.cancelQueries({ queryKey: ["sidebar-navigation-probe"] });
			return;
		}
		return watchNavigationSignals(cache);
	}, [cache, active]);
	useEffect(
		() => () => {
			void cache.cancelQueries({ queryKey: ["sidebar-navigation-probe"] });
		},
		[cache],
	);
}
