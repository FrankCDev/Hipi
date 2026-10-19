import { createHash } from "node:crypto";
import { type Context, getCurrentTools, normalizeContext, type Tool, Type } from "@earendil-works/pi-ai";
import type { ParsedToolPack, ToolPackTool } from "./pack.ts";
import { toolPackToolId } from "./pack.ts";

export type PackageDescriptor = { name: string; digest: string; active: boolean };
export function packDescriptor(pack: ParsedToolPack, tool: ToolPackTool) {
	return {
		name: toolPackToolId(pack, tool.id),
		description: `${pack.manifest.name}: ${pack.manifest.description}\n${tool.name}: ${tool.description}\nTransform one complete authorized UTF-8 file, at most 8 KiB. Returns text and original revision; saving requires hipi_files_save and explicit approval.`,
		parameters: Type.Object(
			{ rootId: Type.String({ minLength: 1, maxLength: 128 }), path: Type.String({ maxLength: 2048 }) },
			{ additionalProperties: false },
		),
	};
}
export function descriptorDigest(tool: Tool): string {
	return createHash("sha256")
		.update(JSON.stringify([tool.name, tool.description, tool.parameters]))
		.digest("hex");
}
/** Inspect historical definitions as well as the final effective tool set. Never infer provenance from prose. */
export function packageDescriptors(context: Context): PackageDescriptor[] {
	const definitions = new Map<string, { name: string; digest: string }>();
	const messages = normalizeContext(context).messages;
	const active = new Map(getCurrentTools(messages).map((tool) => [tool.name, descriptorDigest(tool)]));
	const add = (tool: Tool) => {
		const digest = descriptorDigest(tool);
		if (tool.name.startsWith("pack_")) definitions.set(`${tool.name}:${digest}`, { name: tool.name, digest });
	};
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) add(tool);
	}
	return [...definitions.values()].map((tool) => ({ ...tool, active: active.get(tool.name) === tool.digest }));
}
