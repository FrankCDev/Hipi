import type { QueryClient } from "@tanstack/react-query";

/** Logical catalog changes also retire mixed-pin reads captured during adoption. */
export function invalidateProjectCatalog(cache: QueryClient, includePins = true): void {
	if (includePins) void cache.invalidateQueries({ queryKey: ["sidebar-pins"] });
	void cache.invalidateQueries({ queryKey: ["projects"] });
	void cache.invalidateQueries({ queryKey: ["project-catalog"] });
	void cache.invalidateQueries({ queryKey: ["sidebar-navigation"] });
}
