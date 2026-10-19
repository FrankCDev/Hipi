/** Authoring schema. Byte limits and cross-field uniqueness are enforced by parseToolPack. */
export const TOOL_PACK_LIMITS = Object.freeze({ packageBytes: 65_536, textBytes: 8_192, tools: 8, steps: 16 });
export const PACK_ID_PATTERN = "^(?!hipi(?:\\.|-)|hipi$)[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$(?![\\s\\S])";
export const PACK_VERSION_PATTERN = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$(?![\\s\\S])";
export const TOOL_ID_PATTERN = "^[a-z][a-z0-9_]{0,23}$(?![\\s\\S])";
// With JSON Schema's Unicode regular expressions, paired surrogates are one code point.
export const WELL_FORMED_PATTERN = "^[^\\uD800-\\uDFFF]*$";
const text = (maxLength: number, minLength = 1) => ({
	type: "string",
	minLength,
	maxLength,
	pattern: WELL_FORMED_PATTERN,
});
const simpleOps = ["normalizeNewlines", "trimLineEnds", "removeEmptyLines", "deduplicateLines"] as const;
export const TOOL_PACK_SCHEMA = {
	$schema: "http://json-schema.org/draft-07/schema#",
	title: "Hipi Work declarative tool pack v1",
	type: "object",
	additionalProperties: false,
	required: ["formatVersion", "id", "version", "name", "description", "tools"],
	properties: {
		formatVersion: { const: 1 },
		id: { type: "string", maxLength: 64, pattern: PACK_ID_PATTERN },
		version: { type: "string", maxLength: 32, pattern: PACK_VERSION_PATTERN },
		name: text(80),
		description: text(512),
		tools: {
			type: "array",
			minItems: 1,
			maxItems: TOOL_PACK_LIMITS.tools,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "name", "description", "pipeline"],
				properties: {
					id: { type: "string", pattern: TOOL_ID_PATTERN },
					name: text(80),
					description: text(512),
					pipeline: {
						type: "array",
						minItems: 1,
						maxItems: TOOL_PACK_LIMITS.steps,
						items: {
							oneOf: [
								{
									type: "object",
									additionalProperties: false,
									required: ["op"],
									properties: { op: { enum: simpleOps } },
								},
								{
									type: "object",
									additionalProperties: false,
									required: ["op", "search", "replacement"],
									properties: {
										op: { const: "literalReplace" },
										search: text(1024),
										replacement: text(1024, 0),
									},
								},
							],
						},
					},
				},
			},
		},
	},
} as const;
