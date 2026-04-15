// Shared auth helper - checks signed session cookie
import crypto from 'crypto';

const COOKIE_NAME = 'wr_session';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function issueCookie(res, secret) {
  const token = Date.now().toString();
  const sig = sign(token, secret);
  const cookie = `${COOKIE_NAME}=${token}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
  res.setHeader('Set-Cookie', cookie);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export function requireAuth(req, secret) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return false;
  const val = match.slice(COOKIE_NAME.length + 1);
  const [token, sig] = val.split('.');
  if (!token || !sig) return false;
  const expected = sign(token, secret);
  if (sig !== expected) return false;
  // Valid for 30 days
  const age = Date.now() - parseInt(token);
  if (age > 30 * 24 * 60 * 60 * 1000) return false;
  return true;
}
