import { measureElement, type VirtualItem, type Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";

type Measurement<TScroll extends Element, TItem extends Element> = NonNullable<
	VirtualizerOptions<TScroll, TItem>["measureElement"]
>;

/**
 * Tracks actual measurement calls, including estimate-equal measurements that
 * core 3.19.6 does not cache. Owned by one mounted conversation display; retained
 * keys survive virtual unmounts, but disappear when history/stream rows leave.
 * Use through measureElement only: direct resizeItem calls have no first-measure
 * signal and are not supported by this policy.
 */
export class MessageMeasurementPolicy<TScroll extends Element = HTMLElement, TItem extends Element = HTMLDivElement> {
	private readonly firstMeasurements = new Map<VirtualItem["key"], boolean>();
	private keyExtractor: ((index: number) => VirtualItem["key"]) | undefined;
	private count = -1;
	private readonly blocked: () => boolean;
	private readonly readSize: Measurement<TScroll, TItem>;

	constructor(blocked: () => boolean, readSize: Measurement<TScroll, TItem> = measureElement) {
		this.blocked = blocked;
		this.readSize = readSize;
	}

	/** Call after committed row changes, including commits with no mounted rows. */
	synchronize(instance: Virtualizer<TScroll, TItem>) {
		const { getItemKey, count } = instance.options;
		if (this.keyExtractor === getItemKey && this.count === count) return;
		const retained = new Set(Array.from({ length: count }, (_, index) => getItemKey(index)));
		for (const key of this.firstMeasurements.keys()) {
			if (!retained.has(key)) this.firstMeasurements.delete(key);
		}
		this.keyExtractor = getItemKey;
		this.count = count;
	}

	measureElement: Measurement<TScroll, TItem> = (element, entry, instance) => {
		this.synchronize(instance);
		const size = this.readSize(element, entry, instance);
		const key = instance.options.getItemKey(instance.indexFromElement(element));
		this.firstMeasurements.set(key, !this.firstMeasurements.has(key));
		// Core calls resizeItem synchronously after this returns. Install here,
		// before React's row refs can measure, rather than in a later layout effect.
		instance.shouldAdjustScrollPositionOnItemSizeChange = this.shouldAdjust;
		return size;
	};

	shouldAdjust = (item: VirtualItem, _delta: number, instance: Virtualizer<TScroll, TItem>): boolean => {
		if (this.blocked()) return false;
		const offset = instance.scrollOffset ?? 0;
		return this.firstMeasurements.get(item.key) === true
			? item.start < offset
			: item.end <= offset && instance.scrollDirection !== "backward";
	};

	clear() {
		this.firstMeasurements.clear();
		this.keyExtractor = undefined;
		this.count = -1;
	}
}
