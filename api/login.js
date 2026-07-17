import { issueCookie, clearCookie } from './_auth.js';

export default async function handler(req, res) {
  // DELETE = logout (absorbed from the former api/logout.js so the function
  // count stays under Vercel Hobby's 12-function cap).
  if (req.method === 'DELETE') {
    clearCookie(res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body || {};
  const expected = process.env.AUTH_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!expected || !secret) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // Constant-time compare
  if (!password || password.length !== expected.length) {
    await new Promise(r => setTimeout(r, 300));
    return res.status(401).json({ error: 'Invalid password' });
  }
  let diff = 0;
  for (let i = 0; i < password.length; i++) {
    diff |= password.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    await new Promise(r => setTimeout(r, 300));
    return res.status(401).json({ error: 'Invalid password' });
  }

  issueCookie(res, secret);
  res.status(200).json({ ok: true });
}
