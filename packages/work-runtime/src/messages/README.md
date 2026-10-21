# Committed public block order

Protocol 13 adds optional `Message.publicBlocks`: at most 32 descriptors/2 KiB serialized JSON, with explicit total and omitted. Text descriptors reference UTF-16 ranges in the existing canonical joined public text. Tool descriptors reference the same message's validated tool summary contentIndex; they contain no arguments, reasoning, signatures or duplicated text. Original content indices and duplicate call IDs at different positions are preserved.

Only complete descriptor coverage is suitable for interleaved rendering. Missing/omitted metadata falls back to canonical body plus existing tool summaries without guessing placement. String-content users have one text descriptor at index zero. Adjacent/empty text parts preserve their ranges. A surrogate pair spanning two original text parts makes descriptor coverage incomplete rather than creating split glyphs.

Use one canonical body reader per message, not one reader per block. The parser validates boundaries visible in its supplied canonical prefix; consumers must revalidate as hydration exposes previously unseen boundaries. Clipboard uses the full authoritative public text, not rendered slices. These descriptors do not establish semantic final phase, run membership, or whole-turn completeness.

Snapshot partials deliberately have no descriptors in this slice: they have no immutable message/tool anchor. Do not borrow committed anchors or infer stream order from text similarity.
