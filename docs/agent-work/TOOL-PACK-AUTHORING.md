# Declarative tool packs v1

## Status

The SDK, validator, interpreter, schema, and authoring example are integrated with the workspace lifecycle, PI tool registration, authorization gates, and management UI. See [Tool-pack lifecycle](TOOL-PACK-LIFECYCLE.md) for installation, explicit conversation binding, model disclosure, retained-history authorization, recovery, and verification boundaries. Integration in source is not a desktop release or GUI acceptance claim.

## Boundary

A pack contributes independently named text tools, their descriptions, and ordered pipelines of built-in operations. It is one UTF-8 JSON document, at most 65,536 bytes. It cannot contain JavaScript, WebAssembly, expressions, regular expressions, npm dependencies, file paths, URLs to load, or dynamically loaded code. Strings that happen to contain such text are inert literals, never executable instructions.

The security boundary is that Hipi never executes pack code. This is not a JavaScript sandbox or a general-purpose language. No filesystem, network, process, environment, credentials, or model access is available to this interpreter. Lifecycle and model disclosure authorization belong to the host. A package name, description, or claimed publisher is not proof of provenance or authorization. No `public` declaration or arbitrary user-configuration layer exists.

## Authoring

Use [the JSON Schema](../../examples/tool-packs/tool-pack-v1.schema.json) and [the official two-tool example](../../examples/tool-packs/official-text-cleanup.json). The [TypeScript schema source](../../packages/work-runtime/src/extensions/pack-schema.ts) and exported JSON are checked for equality in tests.

Required top-level fields:

- `formatVersion`: exactly `1`.
- `id`: lowercase dotted namespace, at most 64 characters, such as `org.example.cleanup`. The `hipi` and `hipi-` top-level prefixes are reserved. Namespace claims do not establish publisher identity.
- `version`: exact three-component numeric version such as `1.0.0`, at most 32 characters. No ranges, leading zeroes, prerelease, or build suffixes.
- `name`: 1–80 Unicode code points.
- `description`: 1–512 Unicode code points.
- `tools`: 1–8 tools, each containing only `id`, `name`, `description`, and `pipeline`.

Tool IDs are unique within a pack: an ASCII lowercase letter followed by up to 23 lowercase letters, digits, or underscores. Tool names and descriptions use the same bounds as their pack equivalents. Each pipeline has 1–16 steps. Unknown fields at every level, malformed Unicode, and unsupported versions are rejected. The parser additionally enforces raw byte size, strict UTF-8, and uniqueness of local IDs; those are not fully expressible in standard JSON Schema. UTF-8 BOM is rejected. JSON duplicate object members have standard JSON.parse last-member semantics; authors must not use them.

Each step is exactly one of:

| Operation | Behavior |
| --- | --- |
| `{"op":"normalizeNewlines"}` | CRLF and lone CR become LF. |
| `{"op":"trimLineEnds"}` | Removes ASCII spaces and tabs at the end of LF-separated lines. |
| `{"op":"removeEmptyLines"}` | Removes exactly empty LF-separated lines; whitespace-only lines remain. |
| `{"op":"deduplicateLines"}` | Keeps the first occurrence of each identical LF-separated line, preserving order. |
| `{"op":"literalReplace","search":"，","replacement":","}` | Replaces all non-overlapping literal matches. Search is 1–1,024 code points, replacement 0–1,024. Replacement text such as `$&` stays literal. |

Order is meaningful: normalize newlines before line operations if CR should count as a newline. Literal replacements are not recursively applied within one step. Matching is case-sensitive and does not perform Unicode normalization.

## SDK and identity

The [SDK](../../packages/work-runtime/src/extensions/pack.ts) exposes:

- `parseToolPack(bytes: Uint8Array)`: validates an owned byte snapshot and returns a deeply frozen `{manifest, canonicalId, digest}`. The canonical identity is `id@version`; `digest` is lowercase SHA-256 hex of the actual original bytes, including whitespace. SHA-256 identifies contents; it is not a publisher signature.
- `toolPackToolId(pack, localId)`: returns the provider-safe name `pack_<first 32 digest hex characters>_<localId>`, at most 62 ASCII characters. Full digest is authoritative. Registries must reject all wire-name collisions; truncating a hash is not proof that collisions are impossible. Changed bytes produce a new digest and normally a new wire name, even if `id@version` stays the same.
- `executeToolPack(pack, localId, text, {signal})`: returns the transformed string. It only accepts parser-produced snapshots. After restart, the host must reparse the stored original bytes rather than deserialize an object and pretend it was validated.

Input and each intermediate result are bounded to 8,192 UTF-8 bytes. Oversized values fail without truncation. Literal replacement counts matches and checks resulting byte size before allocating replacement output, including when a later step would shrink it. Chinese and emoji are preserved; lone UTF-16 surrogate code units are rejected.

Execution is a fixed-budget synchronous pure transform, at most 16 steps on 8 KiB. Cancellation is checked before, between, and after steps. A pre-aborted invocation never returns success. JavaScript cannot observe an event-loop abort queued during this synchronous call; the host must also check cancellation before publishing its result. The implementation does not claim hard real-time preemption. More complex computation would require a separately reviewed worker boundary; v1 adds no worker or general-purpose DSL.

Errors expose stable codes without echoing input or pack contents: `INVALID_PACK`, `PACK_TOO_LARGE`, `INVALID_INPUT`, `OUTPUT_TOO_LARGE`, `UNKNOWN_TOOL`, `CANCELLED`.

## Verification

Run the isolated test from the repository root:

`node --conditions=source --test packages/work-runtime/test/extension-pack.test.ts`

The fixture uses repository example data only, no user files, external models, or service calls. Tests compare the schema and parser using the already-installed Ajv test dependency, and cover Unicode, byte limits, raw digest identity, unsupported fields and operations, exact versions, replacement growth, and pre-cancellation. This isolated test is evidence for the pure parser/interpreter; separate lifecycle, real-file, protocol, read-only storage, and UI-session checks are described in [Tool-pack lifecycle](TOOL-PACK-LIFECYCLE.md).
