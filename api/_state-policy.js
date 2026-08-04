// Shared size policy for the user_state table. /api/sync (write) and
// /api/load (read) MUST agree on this — and they didn't.
//
// load.js has refused to return rows over 256KB since ed0ca46, but that
// commit ("api: size-guard load + sync") never actually touched sync.js.
// So the write path accepted values of ANY size while the read path silently
// dropped them: a value over the cap gets stored in Neon, costs a write on
// every change, gets octet_length-probed on every load — and never comes
// back down. A write-only black hole.
//
// `calendar-gcal-cache-v1` sat in that hole at 540KB.

// Vercel serverless functions cap response payloads ~4.5MB. To stay well
// under that we filter giant rows at the SQL level (Neon never ships them
// over the wire), then guard cumulative size in JS as a second backstop.
export const PER_ROW_MAX_BYTES = 256 * 1024;     // 256KB per key — anything bigger is almost certainly broken
export const TOTAL_MAX_BYTES = 3 * 1024 * 1024;  // 3MB cumulative envelope

// The write cap sits slightly under the read cap on purpose. We measure the
// incoming value with Buffer.byteLength(JSON.stringify(v)), but load.js
// measures the STORED value with octet_length(value::text) — and jsonb
// re-encodes on write (whitespace stripped, object keys reordered, some
// unicode re-escaped). The two numbers are close but not identical, so a
// value sitting exactly on the line could pass /api/sync and then be refused
// by /api/load — recreating the black hole this file exists to close. The 5%
// margin makes that impossible in practice.
export const WRITE_MAX_BYTES = Math.floor(PER_ROW_MAX_BYTES * 0.95); // ~249KB
