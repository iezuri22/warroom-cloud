import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

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
  try {
    // Upsert each key. JSONB stored as-is.
    for (const u of updates) {
      if (!u.key || typeof u.key !== 'string') continue;
      // Parse the value. It's sent as a string from localStorage; try JSON, fall back to string.
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
    }
    res.status(200).json({ ok: true, count: updates.length, ts: Date.now() });
  } catch (e) {
    console.error('sync error', e);
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
}
