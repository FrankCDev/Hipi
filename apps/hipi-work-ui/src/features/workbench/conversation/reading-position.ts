import type { AppClient, Scope } from "@hipi/work-runtime/contracts";
import type { VirtualItem } from "@tanstack/react-virtual";

export type ConversationReadingPosition = {
	key: string;
	/** Stable child identity when a measured turn contains multiple messages. */
	messageKey?: string;
	/** Message or row top relative to the scroll viewport, including fractional CSS pixels. */
	pixel: number;
	following: boolean;
	heights: ReadonlyMap<string, number>;
};

const MAX_POSITIONS = 24;
const MAX_HEIGHTS = 256;
let nextOwner = 0;

/** Session-only UI state. No message contents or runtime facts are retained. */
export class ConversationReadingPositions {
	readonly ownerKey = ++nextOwner;
	private readonly positions = new Map<string, ConversationReadingPosition>();

	read(scope: Scope) {
		const key = JSON.stringify([scope.workspaceId, scope.conversationId]);
		return this.positions.get(key);
	}

	save(scope: Scope, position: Omit<ConversationReadingPosition, "heights">, measurements: readonly VirtualItem[]) {
		const anchorIndex = measurements.findIndex((item) => item.key === position.key);
		const nearest = [...measurements]
			.sort(
				(a, b) =>
					Math.abs(a.index - (measurements[anchorIndex]?.index ?? 0)) -
					Math.abs(b.index - (measurements[anchorIndex]?.index ?? 0)),
			)
			.slice(0, MAX_HEIGHTS);
		const heights = new Map(
			nearest
				.filter((item) => typeof item.key === "string" && Number.isFinite(item.size) && item.size > 0)
				.map((item) => [String(item.key), item.size]),
		);
		const key = JSON.stringify([scope.workspaceId, scope.conversationId]);
		this.positions.delete(key);
		this.positions.set(key, { ...position, heights });
		while (this.positions.size > MAX_POSITIONS) {
			const oldest = this.positions.keys().next().value;
			if (oldest === undefined) break;
			this.positions.delete(oldest);
		}
	}

	clear(scope: Scope) {
		this.positions.delete(JSON.stringify([scope.workspaceId, scope.conversationId]));
	}
}

const clientPositions = new WeakMap<AppClient, ConversationReadingPositions>();

/** Identical scope IDs in another store/client never inherit this reader's state. */
export function readingPositionsFor(client: AppClient): ConversationReadingPositions {
	let positions = clientPositions.get(client);
	if (!positions) {
		positions = new ConversationReadingPositions();
		clientPositions.set(client, positions);
	}
	return positions;
}
