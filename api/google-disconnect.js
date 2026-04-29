// Disconnect Google — deletes the saved refresh token from Neon so the next
// /api/google-auth visit triggers a fresh OAuth flow. Useful when calendar
// data looks stale: a fresh refresh_token + reauthorize bypasses any
// per-token caching on Google's end.
import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`DELETE FROM user_state WHERE user_id = 'me' AND key = 'google_refresh_token'`;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('google-disconnect error', e);
    res.status(500).json({ error: e.message });
  }
}
