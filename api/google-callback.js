// OAuth callback — exchanges auth code for tokens, stores refresh_token in Neon
import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).send('Not authenticated. Log into War Room first, then revisit /api/google-auth');
  }

  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`Google denied the request: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Missing auth code');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${host}/api/google-callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      return res.status(500).send(`No refresh_token returned. Raw response: ${JSON.stringify(tokens)}`);
    }

    // Store refresh_token in Neon
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO user_state (user_id, key, value, updated_at)
      VALUES ('me', 'google_refresh_token', ${JSON.stringify(tokens.refresh_token)}::jsonb, NOW())
      ON CONFLICT (user_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`
      <!DOCTYPE html>
      <html><head><title>Google Calendar Connected</title>
      <style>
        body{font-family:system-ui,sans-serif;max-width:500px;margin:80px auto;padding:24px;background:#f4f3f0;color:#1a1a1a}
        .box{background:#fff;border:1px solid #e5e3dc;border-radius:14px;padding:32px;text-align:center}
        h1{font-size:24px;margin-bottom:12px}
        p{color:#6b6a66;line-height:1.5;margin-bottom:20px}
        a{display:inline-block;background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600}
      </style></head><body>
      <div class="box">
        <h1>✓ Google Calendar connected</h1>
        <p>Your refresh token is saved. The calendar refresh button in War Room now pulls live data from Google.</p>
        <a href="/daily-planner.html">Back to War Room</a>
      </div>
      </body></html>
    `);
  } catch (e) {
    console.error('google-callback error', e);
    res.status(500).send('Token exchange failed: ' + e.message);
  }
}
