// Diagnostic: which Google account is the stored refresh_token tied to?
// Also lists the first 20 calendars visible to that account, so we can
// see if the hardcoded calendar IDs in api/calendar.js actually exist there.
import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT value, updated_at FROM user_state WHERE user_id = 'me' AND key = 'google_refresh_token'`;
    if (!rows.length) {
      return res.status(412).json({ error: 'No refresh_token stored. Visit /api/google-auth first.' });
    }
    const refreshToken = rows[0].value;
    const updatedAt = rows[0].updated_at;

    const accessToken = await getAccessToken(refreshToken);

    // Who is signed in?
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();

    // What calendars does this account see?
    const calRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const calData = await calRes.json();
    const calendars = (calData.items || []).map(c => ({
      id: c.id,
      summary: c.summary,
      primary: !!c.primary,
      accessRole: c.accessRole,
    }));

    // Which of the hardcoded IDs match?
    const HARDCODED = [
      'primary',
      'gevtrfnupve04u82ik62pm4ctg2fbonf@import.calendar.google.com',
      'tk2nsridvpuqnulcldem56u8rkel04f7@import.calendar.google.com',
      'addressbook#contacts@group.v.calendar.google.com',
    ];
    const visibleIds = new Set(calendars.map(c => c.id));
    const hardcodedStatus = HARDCODED.map(id => ({
      id,
      present: id === 'primary'
        ? calendars.some(c => c.primary)
        : visibleIds.has(id),
    }));

    res.status(200).json({
      signed_in_as: user.email || '(unknown)',
      name: user.name || null,
      refresh_token_stored_at: updatedAt,
      visible_calendar_count: calendars.length,
      calendars,
      hardcoded_calendar_check: hardcodedStatus,
    });
  } catch (e) {
    console.error('whoami error', e);
    res.status(500).json({ error: e.message });
  }
}
