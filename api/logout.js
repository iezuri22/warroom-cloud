import { clearCookie } from './_auth.js';

export default async function handler(req, res) {
  clearCookie(res);
  res.status(200).json({ ok: true });
}
