import type { ExternalLinkResult } from "@hipi/work-runtime/external-links";
import { trustedSender } from "../ipc/sender.ts";
import { decodeExternalLinkRequest } from "./protocol.ts";

type Owner = { isDestroyed(): boolean; mainFrame: { url: string } };
/** Policy is supplied by the host, never by the request. Restricted fails closed until a real host policy flow exists. */
export class ExternalLinkService {
	private pending = false;
	private readonly owner: Owner;
	private readonly page: string;
	private readonly policy: () => "allow" | "restricted";
	private readonly opener: (url: string) => Promise<void>;
	constructor(
		owner: Owner,
		page: string,
		policy: () => "allow" | "restricted",
		opener: (url: string) => Promise<void>,
	) {
		this.owner = owner;
		this.page = page;
		this.policy = policy;
		this.opener = opener;
	}
	async request(event: { sender: unknown; senderFrame: unknown }, raw: unknown): Promise<ExternalLinkResult> {
		try {
			if (this.owner.isDestroyed() || !trustedSender(event, this.owner, this.page) || this.policy() !== "allow")
				return "denied";
			const { url } = decodeExternalLinkRequest(raw);
			if (this.pending) return "busy";
			this.pending = true;
			try {
				// No await between sender/policy validation and handing this exact URL to the OS.
				await this.opener(url);
				return "opened";
			} catch {
				return "failed";
			} finally {
				this.pending = false;
			}
		} catch {
			return "denied";
		}
	}
}
