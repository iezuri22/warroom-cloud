import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

// Vercel serverless functions cap response payloads around 4.5MB. To stay
// well under that — and to avoid sending bytes the client doesn't need —
// any single key whose serialized value exceeds this threshold is skipped
// and reported in `skipped` instead. Most keys are <1KB; this only kicks
// in when something has gone wrong with one specific entry.
const PER_ROW_MAX_BYTES = 512 * 1024; // 512KB per key
const TOTAL_MAX_BYTES = 3.5 * 1024 * 1024; // 3.5MB cumulative

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const sql = neon(process.env.DATABASE_URL);
  let rows;
  try {
    rows = await sql`SELECT key, value, updated_at FROM user_state WHERE user_id = 'me'`;
  } catch (e) {
    console.error('load db error', e && e.message);
    return res.status(500).json({ error: 'Database error' });
  }
  const state = {};
  const skipped = [];
  let total = 0;
  for (const row of rows) {
    try {
      const valStr = JSON.stringify(row.value);
      const bytes = valStr ? valStr.length : 0;
      if (bytes > PER_ROW_MAX_BYTES) {
        console.warn('load: skipping oversized key', row.key, bytes);
        skipped.push({ key: row.key, bytes, reason: 'oversize' });
        continue;
      }
      if (total + bytes > TOTAL_MAX_BYTES) {
        console.warn('load: total cap reached, skipping', row.key);
        skipped.push({ key: row.key, bytes, reason: 'total-cap' });
        continue;
      }
      total += bytes;
      state[row.key] = { value: row.value, updated_at: row.updated_at };
    } catch (e) {
      console.warn('load row failed', row && row.key, e && e.message);
      skipped.push({ key: row && row.key, error: (e && e.message) ? e.message.slice(0, 240) : 'unknown' });
    }
  }
  res.status(200).json({ state, skipped, totalBytes: total });
}
