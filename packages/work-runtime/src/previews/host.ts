import type { TrustedFileAuthority } from "../files/service.ts";
import { DocumentParserPool } from "./parser-pool.ts";
import { createPreviewRequestHandler } from "./protocol.ts";
import { createPreviewService } from "./service.ts";

/** Shared grants, independent preview lifecycle. Closing previews never grants or closes file access. */
export function createRuntimePreviewHost(options: {
	authority: TrustedFileAuthority;
	principalId: string;
	storeId: string;
	workerUrl?: URL;
}) {
	const service = createPreviewService({
		source: options.authority.forPrincipalSnapshot(options.principalId),
		parser: new DocumentParserPool(options.workerUrl ? { workerUrl: options.workerUrl } : undefined),
		principalId: options.principalId,
		storeId: options.storeId,
	});
	return { handler: createPreviewRequestHandler(service.client, options.storeId), close: service.close };
}
