import { AppError, type Page } from "@hipi/work-runtime/contracts";

export type CatalogPage<T> = Page<T> & { previousCursor?: string | null };
export const CATALOG_READ_DEADLINE_MS = 15_000;
export type CatalogReadProgress<P> = {
	start?: string;
	direction: "forward" | "backward";
	cursor?: string;
	first?: P;
	recent: string[];
};
export type CatalogReadOwner<P> = { progress?: CatalogReadProgress<P> };

/** The read owner removes its scheduled continuation on cancellation. */
export async function yieldCatalogRead(signal: AbortSignal) {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 0);
		signal.addEventListener("abort", abort, { once: true });
	});
	signal.throwIfAborted();
}

/** Empty candidate ranges do not consume the five visible page slots. A timed-out demand resumes its last verified cursor. */
export async function readCatalogPage<T, P extends CatalogPage<T>>(
	read: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
	start: string | undefined,
	direction: "forward" | "backward",
	signal: AbortSignal,
	owner: CatalogReadOwner<P>,
): Promise<P> {
	const progress: CatalogReadProgress<P> =
		owner.progress && owner.progress.start === start && owner.progress.direction === direction
			? owner.progress
			: { start, direction, cursor: start, recent: [] };
	owner.progress = progress;
	const deadline = AbortSignal.timeout(CATALOG_READ_DEADLINE_MS);
	const demand = AbortSignal.any([signal, deadline]);
	let reads = 0;
	for (;;) {
		demand.throwIfAborted();
		const page = await read(progress.cursor, demand);
		demand.throwIfAborted();
		const next = direction === "backward" ? page.previousCursor : page.nextCursor;
		if (next && (next === progress.cursor || next === start || progress.recent.includes(next))) {
			owner.progress = undefined;
			throw new AppError("INVALID_REQUEST");
		}
		if (progress.first && catalogPublication(progress.first) !== catalogPublication(page)) {
			owner.progress = undefined;
			throw new AppError("CURSOR_STALE");
		}
		progress.first ??= page;
		if (
			page.items.length ||
			!next ||
			("coverage" in page && (page.coverage as { state?: string }).state === "building")
		) {
			owner.progress = undefined;
			return direction === "forward"
				? { ...page, ...("previousCursor" in progress.first ? { previousCursor: progress.first.previousCursor } : {}) }
				: {
						...page,
						nextCursor: progress.first.nextCursor,
						...("nextPinKey" in progress.first ? { nextPinKey: progress.first.nextPinKey } : {}),
						...("nextPinnedScope" in progress.first ? { nextPinnedScope: progress.first.nextPinnedScope } : {}),
					};
		}
		progress.cursor = next;
		progress.recent = [...progress.recent, next].slice(-16);
		if (++reads % 5 === 0) await yieldCatalogRead(demand);
	}
}

export function catalogPublication(page: unknown): string {
	const value = page as Record<string, unknown>;
	const coverage = value.coverage as Record<string, unknown> | undefined;
	return JSON.stringify([
		value.metadataGeneration,
		value.orderGeneration,
		value.orderRevision,
		coverage?.generation,
		coverage?.membershipGeneration,
		coverage?.projectMembershipGeneration,
		coverage?.projectOrderGeneration,
	]);
}
