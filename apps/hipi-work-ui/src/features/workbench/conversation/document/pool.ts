import type { AppClient } from "@hipi/work-runtime/contracts";
import { MessageDocumentPool } from "./owner.ts";

const pools = new WeakMap<AppClient, MessageDocumentPool>();
/** A transport identity owns its source cache. Connection replacement cannot reuse another authority's bytes. */
export function messageDocumentPool(client: AppClient) {
	let pool = pools.get(client);
	if (!pool) {
		pool = new MessageDocumentPool();
		pools.set(client, pool);
	}
	return pool;
}
