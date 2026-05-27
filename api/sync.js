import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { isTransientDbError, isQuotaError } from './_db-errors.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { updates } = req.body || {};
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  const sql = neon(process.env.DATABASE_URL);
  // Per-item try/catch: one bad row should not kill the whole batch.
  // We return both success + failure lists so the client can drop bad
  // keys from its retry queue instead of looping forever — EXCEPT when
  // the failure is transient (Neon quota / 5xx / network), in which case
  // we mark it `transient: true` so the client retries instead of poisoning.
  const ok = [];
  const failed = [];
  let quotaHit = false;
  for (const u of updates) {
    if (!u.key || typeof u.key !== 'string') continue;
    try {
      let parsed = u.value;
      if (typeof u.value === 'string') {
        try { parsed = JSON.parse(u.value); } catch { parsed = u.value; }
      }
      if (parsed === null || parsed === undefined) {
        await sql`DELETE FROM user_state WHERE user_id = 'me' AND key = ${u.key}`;
      } else {
        await sql`
          INSERT INTO user_state (user_id, key, value, updated_at)
          VALUES ('me', ${u.key}, ${JSON.stringify(parsed)}::jsonb, NOW())
          ON CONFLICT (user_id, key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `;
      }
      ok.push(u.key);
    } catch (e) {
      const msg = (e && e.message) || 'unknown';
      const transient = isTransientDbError(e);
      if (isQuotaError(e)) quotaHit = true;
      console.error('sync row failed', { key: u.key, err: msg, transient });
      failed.push({ key: u.key, error: msg.slice(0, 240), transient });
    }
  }
  // If literally nothing succeeded AND every failure was transient (e.g. quota
  // hit blocked the whole batch), return 503 so the client retries the whole
  // batch with backoff instead of just inspecting the `failed` list.
  if (ok.length === 0 && failed.length > 0 && failed.every(f => f.transient)) {
    return res.status(503).json({
      ok: false,
      applied: 0,
      failed,
      quotaExceeded: quotaHit,
      ts: Date.now()
    });
  }
  // 200 even with partial failures — client uses `transient` flag on each
  // failed row to decide retry vs poison.
  res.status(200).json({ ok: true, applied: ok.length, failed, quotaExceeded: quotaHit, ts: Date.now() });
}
