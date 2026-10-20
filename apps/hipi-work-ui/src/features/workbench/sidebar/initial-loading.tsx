import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import "./initial-loading.css";

/** Observe the existing query owners; this shell never starts or remounts an inventory query. */
export function isSidebarInitialLoading(cache: QueryClient) {
	const queries = cache
		.getQueryCache()
		.getAll()
		.filter((query) => {
			if (!query.isActive()) return false;
			const [owner, view, filter] = query.queryKey;
			if (owner === "projects" || owner === "sidebar-pins") return query.queryKey.length === 2 && view === "pages";
			return (
				owner === "sidebar-navigation" &&
				query.queryKey.length === 3 &&
				view !== null &&
				typeof view === "object" &&
				"kind" in view &&
				["recent", "project_recent", "workspace", "project"].includes(String(view.kind)) &&
				(filter === "active" || filter === "archived" || filter === "all")
			);
		});
	if (queries.some((query) => query.state.status === "error")) return false;
	for (const query of queries) {
		const data = query.state.data;
		if (!data || typeof data !== "object" || !("pages" in data) || !Array.isArray(data.pages)) continue;
		if (
			data.pages.some(
				(page: unknown) =>
					page && typeof page === "object" && "items" in page && Array.isArray(page.items) && page.items.length > 0,
			)
		)
			return false;
	}
	return queries.some((query) => query.state.status === "pending");
}

export function SidebarInitialLoading({ children }: { children: ReactNode }) {
	const cache = useQueryClient();
	const { locale } = usePreferences();
	const subscribe = useCallback((listener: () => void) => cache.getQueryCache().subscribe(listener), [cache]);
	const snapshot = useCallback(() => isSidebarInitialLoading(cache), [cache]);
	const loading = useSyncExternalStore(subscribe, snapshot, snapshot);
	return (
		<>
			{loading && (
				<output className="sidebar-initial-loading">
					<span className="sr-only">{locale === "en" ? "Loading chats…" : "正在加载聊天…"}</span>
					<span className="sidebar-loading-heading" aria-hidden="true" />
					{[0, 1, 2, 3].map((row) => (
						<span key={row} className="sidebar-loading-row" aria-hidden="true" />
					))}
				</output>
			)}
			<div className="sidebar-loaded-sections" hidden={loading}>
				{children}
			</div>
		</>
	);
}
