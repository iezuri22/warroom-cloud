import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { isTransientDbError, isQuotaError } from './_db-errors.js';

// How many `<key>__rejected_<iso>` backups to keep per guarded key. The backup
// key embeds a timestamp, so every rejection writes a NEW row — without a cap
// they accumulate forever. These are a debugging audit trail (nothing reads
// them client-side); the newest few are the only ones with diagnostic value.
const BACKUP_RETENTION = 5;

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

  // ----- Empty-clobber guard -----
  // The client has wiped Focus 5 priority lists three times due to a
  // bootstrap race that pushes an empty-defaults state up before the
  // cloud finishes hydrating. This server-side guard makes that
  // impossible: for known "container" keys, if the cloud row currently
  // holds user data and the incoming write is structurally empty (all
  // taskIds arrays empty), we REJECT the write and back the payload up
  // to `<key>__rejected_<iso>` for audit.
  //
  // To extend protection to a new key, add a (cur, next) predicate that
  // returns true when `next` would wipe `cur`.
  const EMPTY_CLOBBER_GUARDED = {
    'personal-focus-5-v1': (cur, next) => {
      const curLists  = cur  && Array.isArray(cur.lists)  ? cur.lists  : null;
      const nextLists = next && Array.isArray(next.lists) ? next.lists : null;
      if (!curLists || !nextLists) return false;
      const curHasTasks  = curLists.some(l => Array.isArray(l && l.taskIds) && l.taskIds.length > 0);
      const nextHasTasks = nextLists.some(l => Array.isArray(l && l.taskIds) && l.taskIds.length > 0);
      return curHasTasks && !nextHasTasks;
    }
  };

  async function clobbersExistingData(key, incomingValue) {
    const check = EMPTY_CLOBBER_GUARDED[key];
    if (!check) return false;
    try {
      const rows = await sql`
        SELECT value FROM user_state WHERE user_id = 'me' AND key = ${key} LIMIT 1
      `;
      if (!rows.length) return false; // no existing row → nothing to clobber
      return check(rows[0].value, incomingValue);
    } catch (e) {
      // If the existence probe itself fails, fail OPEN (allow the write).
      // Better to risk one bad write than to silently reject all legit ones.
      console.warn('clobber guard read failed', key, e && e.message);
      return false;
    }
  }

  // Per-item try/catch: one bad row should not kill the whole batch.
  // We return both success + failure lists so the client can drop bad
  // keys from its retry queue instead of looping forever — EXCEPT when
  // the failure is transient (Neon quota / 5xx / network), in which case
  // we mark it `transient: true` so the client retries instead of poisoning.
  const ok = [];
  const failed = [];
  const rejected = []; // non-transient, non-retryable: guard refused this write
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
        // Empty-clobber guard
        if (await clobbersExistingData(u.key, parsed)) {
          const backupKey = `${u.key}__rejected_${new Date().toISOString().replace(/[:.]/g, '-')}`;
          const backupPrefix = `${u.key}__rejected_`;
          try {
            await sql`
              INSERT INTO user_state (user_id, key, value, updated_at)
              VALUES ('me', ${backupKey}, ${JSON.stringify(parsed)}::jsonb, NOW())
              ON CONFLICT (user_id, key)
              DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            `;
            // Trim to the newest BACKUP_RETENTION for this key. starts_with()
            // rather than LIKE on purpose: keys contain `_`, which LIKE treats
            // as a wildcard, and widening the match here would widen a DELETE.
            // Tie-break on key DESC — the embedded ISO timestamp sorts
            // chronologically, so it orders rows sharing an updated_at.
            await sql`
              DELETE FROM user_state
              WHERE user_id = 'me'
                AND starts_with(key, ${backupPrefix})
                AND key NOT IN (
                  SELECT key FROM user_state
                  WHERE user_id = 'me' AND starts_with(key, ${backupPrefix})
                  ORDER BY updated_at DESC, key DESC
                  LIMIT ${BACKUP_RETENTION}
                )
            `;
          } catch (_) { /* best-effort audit; ignore errors */ }
          console.warn('sync rejected empty-clobber', { key: u.key, backupKey });
          rejected.push({ key: u.key, reason: 'empty_clobber', backupKey });
          continue; // skip the real write; client should NOT mark this poisoned
        }
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
      rejected,
      quotaExceeded: quotaHit,
      ts: Date.now()
    });
  }
  // 200 even with partial failures — client uses `transient` flag on each
  // failed row to decide retry vs poison.
  res.status(200).json({ ok: true, applied: ok.length, failed, rejected, quotaExceeded: quotaHit, ts: Date.now() });
}
