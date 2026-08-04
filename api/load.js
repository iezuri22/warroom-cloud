import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { isTransientDbError, isQuotaError } from './_db-errors.js';
import { PER_ROW_MAX_BYTES, TOTAL_MAX_BYTES } from './_state-policy.js';

// Every entry in the `skipped` list carries `structural`, which tells the
// client whether it may permanently poison the key:
//   structural: true  → the value itself is the problem (too big, unreadable).
//                       Retrying pushes the same broken bytes. Safe to poison.
//   structural: false → the key is fine; it lost a race for the response
//                       budget. Poisoning it would permanently disable sync
//                       for a perfectly good key — the exact bug c7e5aa3
//                       fixed on the sync path and left open on this one.

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
    `;
    oversized = sizeRows.map(r => ({
      key: r.key,
      bytes: Number(r.bytes),
      reason: 'oversize',
      max: PER_ROW_MAX_BYTES,
      structural: true
    }));
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
        // NOT structural: this key is under the per-row cap and is only being
        // dropped because the cumulative envelope filled up first. Rows are
        // ordered by size ASC, so the casualties here are the LARGEST keys —
        // i.e. the user's real data (todos-cache, ui-state), not junk.
        skipped.push({ key: row.key, bytes, reason: 'total-cap', structural: false });
        continue;
      }
      total += bytes;
      state[row.key] = { value: row.value, updated_at: row.updated_at };
    } catch (e) {
      skipped.push({
        key: row && row.key,
        reason: 'unreadable',
        error: (e && e.message) ? e.message.slice(0, 240) : 'unknown',
        structural: true
      });
    }
  }
  if (skipped.length) console.warn('load: skipped keys', skipped);
  res.status(200).json({ state, skipped, totalBytes: total });
}
