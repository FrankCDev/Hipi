import { type RefObject, useEffect, useRef } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { catalogLabels } from "./catalog-labels.ts";

type Pagination = {
	hasMore: boolean;
	canRestart: boolean;
	isFetching: boolean;
	isLoadingMore: boolean;
	isError: boolean;
	windowed: boolean;
	atLimit: boolean;
	loadMore: () => Promise<void>;
	restart: () => Promise<void>;
};

/** Preserve keyboard focus when the last page removes its own Load more button. */
export function CatalogPagination({ pages, listRef }: { pages: Pagination; listRef: RefObject<HTMLElement | null> }) {
	const { locale } = usePreferences();
	const l = catalogLabels(locale);
	const first = useRef<HTMLButtonElement>(null);
	const more = useRef<HTMLButtonElement>(null);
	const origin = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (pages.isFetching || !origin.current) return;
		const previous = origin.current;
		origin.current = null;
		if (!previous.isConnected && document.activeElement === document.body) {
			const remainingControl = pages.canRestart ? first.current : pages.hasMore ? more.current : null;
			(remainingControl ?? listRef.current)?.focus({ preventScroll: true });
		}
	}, [pages.isFetching, pages.hasMore, pages.canRestart, listRef]);
	if (!pages.hasMore && !pages.canRestart) return null;
	return (
		<div className="catalog-pagination">
			{(pages.atLimit || pages.windowed) && (
				<p className="catalog-window-note">{pages.windowed ? l.windowed : l.windowLimit}</p>
			)}
			<div className="project-pagination">
				{pages.canRestart && (
					<Button
						ref={first}
						variant="ghost"
						size="sm"
						aria-disabled={pages.isFetching}
						onClick={(event) => {
							if (pages.isFetching) return;
							origin.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
							void pages.restart();
						}}
					>
						{l.first}
					</Button>
				)}
				{pages.hasMore && (
					<Button
						ref={more}
						variant="ghost"
						size="sm"
						aria-disabled={pages.isFetching || pages.isError}
						onClick={(event) => {
							if (pages.isFetching || pages.isError) return;
							origin.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
							void pages.loadMore();
						}}
					>
						{pages.isLoadingMore ? l.loadingMore : l.loadMore}
					</Button>
				)}
			</div>
		</div>
	);
}
