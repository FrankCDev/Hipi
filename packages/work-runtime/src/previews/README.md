# Bounded document parsing

Hosts own a `DocumentParserPool`, pass authorized immutable input snapshots to
`parse(format, bytes, signal)`, and await `close()` during shutdown. Do not call
`parseDocumentBytes` from a host event loop. It is an internal worker entry.
The browser-safe `contracts.ts` exposes only scalars, strings, arrays and stable
error codes. `validateDocumentPreview` reconstructs and bounds incoming DTOs,
rejecting extra properties. Render text with ordinary text nodes, never HTML.

## Supported projection

- DOCX: Mammoth `extractRawText`, not HTML conversion. Plain text only; layout,
  pictures and embedded objects are omitted. This is not a Word renderer.
- XLSX: SheetJS typed cells and formatted display strings. Values of formulas
  are the file's cached results, potentially stale. No formula recalculation,
  macro execution, clickable links, charts or layout reproduction.
- CSV: PapaParse string cells, UTF-8 only, inferred delimiter, quoted/multiline
  fields. Formula-looking text stays text. No automatic downloads.

Legacy DOC/XLS, encrypted packages, macro/embedded OLE content and unsafe ZIP
paths are rejected. Office XML parts must be UTF-8. Preview data is deliberately
partial when text/grid/output budgets are reached; `truncated` describes that.

## Limits and isolation

Input is rejected before copying above 8 MiB. Admission caps two active workers,
eight queued requests and 32 MiB of aggregate owned input, including active
requests. Queued abort removes its input and listener immediately. Running abort,
timeout, completion and close terminate the worker before reusing its slot.
If termination itself rejects, the pool fails closed, retains the unconfirmed
slot and reports a close error instead of claiming successful cleanup.

ZIP validation uses yauzl lazy entries and sequential stream consumption. It
checks declared sizes and actual inflated bytes: 32 MiB total, 8 MiB per entry,
2,048 entries and maximum compression ratio 100 per entry. It rejects encrypted,
duplicate (case-insensitive), traversal, symlink and macro/OLE entries. Every
entry is scanned for DTD/entity declarations, including arbitrary-extension
parts; XML/relationship files additionally receive strict UTF-8 checks. Libraries
never receive the original archive. The validator verifies each entry's CRC and
returns a private, uncompressed STORE ZIP containing only the inspected entries.
Local and central names, sizes, checksums and entry counts are generated from
that inspected content. Original local headers, extra fields, data descriptors,
comments and uninspected entries are not forwarded. This prevents a downstream
reader from trusting different ZIP metadata and allocating or parsing content
that validation never approved. Valid streaming data descriptors and ZIP64 input
are normalized rather than rejected. No archive extraction touches disk.

Generated UTF-8 names are capped at 65,535 bytes each and 8 MiB combined. The
normalized archive is bounded by 32 MiB payload, twice the name budget, 76 bytes
per entry and a 22-byte trailer. Final concatenation temporarily holds the entry
buffers and the new archive together; these native buffers are additional to V8
heap usage, not covered by a worker heap limit or a process-wide RSS guarantee.

Each job has a 5 second wall-clock timeout and V8 resource limits (128 MiB old
generation, 16 MiB young generation, 4 MiB stack). These limits and worker threads
are **not an OS permission sandbox**: they do not revoke filesystem/network
permissions or impose an OS-wide RSS cap. The parser code does not load external
resources, but a compromised dependency has the process user's permissions.
The limits are conservative initial budgets, not measured production performance
guarantees across platforms.

Projection is capped at eight sheets, 200 rows and 50 columns per sheet, 4,096
characters per cell, 120,000 DOCX characters, and 1 MiB serialized output. SheetJS
also receives row and sheet limits before parsing; ZIP and worker budgets bound
the remaining library allocations. CSV consumes steps and aborts once the
projection budget is exhausted. DTO collection accounts for output before adding
cells, with a final wire-size check.

## Packaging and tests

Development defaults to the adjacent `parser-worker.ts`. Packaged hosts must pass
`workerUrl` pointing at a separately bundled Node worker entry; do not infer the
source tree relative to a host bundle. ESM bundles of CJS dependencies need the
Node `createRequire` banner used by the desktop build. Include parser dependencies
in that worker bundle and verify it after relocating outside the checkout.

`test/document-parsers.test.ts` builds synthetic files entirely in memory and
checks real worker parsing, plain-text/cached/string behavior, byte snapshots,
malicious archives, streaming budgets, bounded admission, cancellation, forced
timeout, close and termination-failure cleanup. It does not read user documents
or contact real services. `test/office-zip-normalization.test.ts` covers conflicting
local sizes and entry counts, CRC/symlink rejection, UTF-8 name budgets, generated
metadata, input ownership and real worker compatibility for compressed XLSX,
Unicode, streaming descriptors and ZIP64 DOCX. Allocation attacks use tiny
synthetic payloads and trap the forged allocation before it occurs. Desktop
relocation and cross-platform acceptance are separate checks; passing these unit
tests is not release certification.
