import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ authenticated: false });
  }
  res.status(200).json({ authenticated: true });
}
