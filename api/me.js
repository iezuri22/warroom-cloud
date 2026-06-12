import { requireAuth, sessionAgeMs, issueCookie } from './_auth.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ authenticated: false });
  }
  // Sliding renewal: every page load hits /api/me (via sync-client), so
  // re-issuing the cookie once the session is over 7 days old means active
  // users never hit the hard 30-day expiry. Only idle-for-30-days sessions
  // still have to log in again.
  const age = sessionAgeMs(req, secret);
  if (age != null && age > 7 * 24 * 60 * 60 * 1000) {
    issueCookie(res, secret);
  }
  res.status(200).json({ authenticated: true });
}
