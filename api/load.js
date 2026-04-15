import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const rows = await sql`SELECT key, value, updated_at FROM user_state WHERE user_id = 'me'`;
    const state = {};
    for (const row of rows) {
      state[row.key] = { value: row.value, updated_at: row.updated_at };
    }
    res.status(200).json({ state });
  } catch (e) {
    console.error('load error', e);
    res.status(500).json({ error: 'Database error' });
  }
}
