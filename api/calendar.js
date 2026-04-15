// Live Google Calendar fetch — uses stored refresh_token from Neon
// Returns events grouped by date in War Room's seed format
import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

const CALENDARS = [
  { id: 'primary', label: 'Personal' },
  { id: 'gevtrfnupve04u82ik62pm4ctg2fbonf@import.calendar.google.com', label: 'TWEG' },
  { id: 'tk2nsridvpuqnulcldem56u8rkel04f7@import.calendar.google.com', label: 'Partiful' },
];

function formatTime(date) {
  const h = date.getHours(), m = date.getMinutes();
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ap = h >= 12 ? 'PM' : 'AM';
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

function formatTimeRange(startISO, endISO) {
  const s = new Date(startISO), e = new Date(endISO);
  return `${formatTime(s)} - ${formatTime(e)}`;
}

function dateKey(d) {
  // Chicago local time date (events are returned in America/Chicago)
  const opts = { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

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
    throw new Error('Failed to refresh Google access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function fetchCalendarEvents(accessToken, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    timeZone: 'America/Chicago',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Calendar ${calendarId} fetch failed: ${res.status} ${text}`);
  }
  return (await res.json()).items || [];
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Load refresh token from Neon
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT value FROM user_state WHERE user_id = 'me' AND key = 'google_refresh_token'`;
    if (!rows.length) {
      return res.status(412).json({
        error: 'Google Calendar not connected',
        action: 'Visit /api/google-auth to connect your calendar'
      });
    }
    const refreshToken = rows[0].value;

    // Determine time range: current month + next month
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59).toISOString();

    const accessToken = await getAccessToken(refreshToken);

    // Fetch all 3 calendars in parallel
    const results = await Promise.all(
      CALENDARS.map(cal =>
        fetchCalendarEvents(accessToken, cal.id, timeMin, timeMax)
          .then(items => items.map(ev => ({ ...ev, _calLabel: cal.label })))
          .catch(err => {
            console.warn(`Failed to fetch ${cal.label}:`, err.message);
            return [];
          })
      )
    );
    const allEvents = results.flat();

    // Transform into War Room seed format, grouped by date key
    const byDate = {};
    for (const ev of allEvents) {
      if (!ev.start) continue;
      const isAllDay = !!ev.start.date;
      const startISO = ev.start.dateTime || (ev.start.date ? `${ev.start.date}T06:00:00-05:00` : null);
      const endISO = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T23:59:00-05:00` : null);
      if (!startISO) continue;

      if (isAllDay) {
        // Multi-day all-day events: one entry per day
        const start = new Date(ev.start.date + 'T12:00:00');
        const end = new Date(ev.end.date + 'T12:00:00');
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
          const dk = dateKey(d);
          if (!byDate[dk]) byDate[dk] = [];
          byDate[dk].push({
            id: `${slugify(ev.summary)}-${dk}`,
            summary: ev.summary || '(untitled)',
            time: 'All day',
            location: ev.location || '',
            startISO: `${dk}T06:00:00-05:00`,
            cal: ev._calLabel,
            allDay: true,
          });
        }
      } else {
        const dk = dateKey(new Date(startISO));
        if (!byDate[dk]) byDate[dk] = [];
        byDate[dk].push({
          id: ev.id || `${slugify(ev.summary)}-${dk}-${byDate[dk].length}`,
          summary: ev.summary || '(untitled)',
          time: formatTimeRange(startISO, endISO || startISO),
          location: ev.location || '',
          startISO,
          cal: ev._calLabel,
        });
      }
    }

    // Sort events per day by startISO
    for (const dk of Object.keys(byDate)) {
      byDate[dk].sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0));
    }

    res.status(200).json({
      ok: true,
      synced_at: new Date().toISOString(),
      event_count: allEvents.length,
      by_date: byDate,
    });
  } catch (e) {
    console.error('calendar fetch error', e);
    res.status(500).json({ error: e.message });
  }
}
