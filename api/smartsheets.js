// Server-side proxy for Smartsheets API. The browser can't call
// api.smartsheet.com directly because Smartsheets doesn't send CORS headers,
// so we forward the call from this Vercel function instead. The browser sends:
//
//   POST /api/smartsheets?path=/sheets/12345&method=GET
//   Authorization: Bearer <smartsheets_user_token>
//   body: <forwarded as-is for PUT/POST>
//
// Auth is either:
//   1. Owner: valid War Room session cookie + Authorization header with the
//      owner's Smartsheets bearer token.
//   2. Team: `x-team-token` header matching TEAM_ACCESS_TOKEN env var. In this
//      mode the server injects its own Smartsheets bearer (SMARTSHEET_API_TOKEN
//      env var) so team members don't need direct access to the token.
import { requireAuth } from './_auth.js';

const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';
// Allow-list of paths the proxy will forward — keeps the proxy from being
// abused as a generic relay if the cookie ever leaks.
const ALLOWED_PATH_RE = /^\/sheets\/\d+(\/(rows(\/\d+)?|columns|attachments|discussions))?$/;

export default async function handler(req, res) {
  const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const TEAM_TOKEN    = process.env.TEAM_ACCESS_TOKEN || '';
  const TEAM_SS_TOKEN = process.env.SMARTSHEET_API_TOKEN || '';

  // Detect auth mode: prefer the team header if present (so teammates with
  // BOTH a cookie and a token cleanly get team behavior).
  const teamHeader = (req.headers['x-team-token'] || '').toString();
  const isTeam = TEAM_TOKEN && teamHeader && teamHeader === TEAM_TOKEN;
  const isOwner = !isTeam && requireAuth(req, SESSION_SECRET);
  if (!isTeam && !isOwner) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Browser sends path + intended method via query params. We use POST as the
  // wrapper method so request bodies work regardless of intent.
  const path = (req.query.path || '').toString();
  const targetMethod = (req.query.method || 'GET').toString().toUpperCase();
  if (!ALLOWED_PATH_RE.test(path)) {
    res.status(400).json({ error: 'path not allowed', path });
    return;
  }
  if (!['GET', 'PUT', 'POST', 'DELETE'].includes(targetMethod)) {
    res.status(400).json({ error: 'method not allowed' });
    return;
  }

  // Authorization source: owner mode uses the bearer they sent; team mode uses
  // the server-side Smartsheets token so teammates never touch the raw key.
  let auth;
  if (isTeam) {
    if (!TEAM_SS_TOKEN) {
      res.status(500).json({ error: 'team_smartsheets_token_unset' });
      return;
    }
    auth = 'Bearer ' + TEAM_SS_TOKEN;
  } else {
    auth = req.headers.authorization || '';
    if (!/^Bearer\s+/.test(auth)) {
      res.status(400).json({ error: 'missing Smartsheets Bearer token' });
      return;
    }
  }

  const url = SMARTSHEET_BASE + path;
  const init = {
    method: targetMethod,
    headers: {
      'Authorization': auth,
      'Accept': 'application/json',
    },
  };
  if (targetMethod !== 'GET' && targetMethod !== 'DELETE' && req.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status);
    // Pass through Smartsheets' content type if it returned JSON-shaped text
    res.setHeader('Content-Type', r.headers.get('Content-Type') || 'application/json');
    res.send(text);
  } catch (e) {
    console.error('smartsheets proxy error:', e);
    res.status(502).json({ error: 'upstream_failed', message: e.message });
  }
}
