import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { isTransientDbError, isQuotaError } from './_db-errors.js';

// Vercel serverless functions cap response payloads ~4.5MB. To stay well
// under that we filter giant rows at the SQL level (Neon never ships them
// over the wire), then guard cumulative size in JS as a second backstop.
const PER_ROW_MAX_BYTES = 256 * 1024;     // 256KB per key — anything bigger is almost certainly broken
const TOTAL_MAX_BYTES = 3 * 1024 * 1024;  // 3MB cumulative envelope

// `<key>__rejected_<iso>` rows are backups written by api/sync.js's
// empty-clobber guard: a debugging audit trail, not app state. Nothing reads
// them client-side, and sync-client.js bootstrap() hydrates whatever we return
// straight into localStorage — so shipping them would burn both the envelope
// above and the browser's ~5MB localStorage budget on dead weight.
// position() rather than LIKE: no metacharacters to escape.
const REJECTED_MARKER = '__rejected_';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // ----- Step 1: discover oversized rows by name without pulling their content -----
  let oversized = [];
  try {
    const sizeRows = await sql`
      SELECT key, octet_length(value::text) AS bytes
      FROM user_state
      WHERE user_id = 'me' AND octet_length(value::text) > ${PER_ROW_MAX_BYTES}
        AND position(${REJECTED_MARKER} in key) = 0
    `;
    oversized = sizeRows.map(r => ({ key: r.key, bytes: Number(r.bytes), reason: 'oversize' }));
  } catch (e) {
    // If the size probe itself fails, fall through and try the regular query —
    // worst case we'll still error out below with a clear log.
    console.warn('load size probe failed', e && e.message);
  }

  // ----- Step 2: fetch only rows that pass the size guard -----
  let rows;
  try {
    rows = await sql`
      SELECT key, value, updated_at
      FROM user_state
      WHERE user_id = 'me' AND octet_length(value::text) <= ${PER_ROW_MAX_BYTES}
        AND position(${REJECTED_MARKER} in key) = 0
      ORDER BY octet_length(value::text) ASC
    `;
  } catch (e) {
    const transient = isTransientDbError(e);
    const quotaExceeded = isQuotaError(e);
    console.error('load db error', e && e.message, { transient, quotaExceeded });
    // 503 for transient (quota / 5xx / network) so the client knows this is
    // worth retrying and does NOT treat it as a permanent failure.
    return res.status(transient ? 503 : 500).json({
      error: quotaExceeded ? 'quota_exceeded' : (transient ? 'database_unavailable' : 'Database error'),
      detail: (e && e.message) || '',
      transient,
      quotaExceeded
    });
  }

  // ----- Step 3: assemble response with cumulative cap -----
  const state = {};
  const skipped = [...oversized];
  let total = 0;
  for (const row of rows) {
    try {
      const valStr = JSON.stringify(row.value);
      const bytes = valStr ? Buffer.byteLength(valStr, 'utf8') : 0;
      if (total + bytes > TOTAL_MAX_BYTES) {
        skipped.push({ key: row.key, bytes, reason: 'total-cap' });
        continue;
      }
      total += bytes;
      state[row.key] = { value: row.value, updated_at: row.updated_at };
    } catch (e) {
      skipped.push({ key: row && row.key, error: (e && e.message) ? e.message.slice(0, 240) : 'unknown' });
    }
  }
  if (skipped.length) console.warn('load: skipped keys', skipped);
  res.status(200).json({ state, skipped, totalBytes: total });
}
