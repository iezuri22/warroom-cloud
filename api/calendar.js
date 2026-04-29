// Live Google Calendar fetch — uses stored refresh_token from Neon
// Returns events grouped by date in War Room's seed format
import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';

// Fallback hardcoded list — used only if the dynamic discovery fails.
// Real list is fetched via calendarList.list() below so we're resilient to
// calendar IDs changing when the user re-subscribes to an iCal feed.
const CALENDARS_FALLBACK = [
  { id: 'primary', label: 'Personal' },
];

// Pull the user's full calendar list and shape it into our { id, label }
// format. We always include 'primary' explicitly because it's special.
async function discoverCalendars(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&showHidden=false', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn('calendarList fetch failed', res.status, await res.text().catch(() => ''));
      return CALENDARS_FALLBACK;
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const out = [{ id: 'primary', label: 'Personal' }];
    for (const cal of items) {
      if (!cal.id) continue;
      // Skip the primary alias so we don't double-fetch
      if (cal.primary) continue;
      // Skip the holidays calendar (noise) but keep birthdays + everything else
      if (/holiday@group/.test(cal.id)) continue;
      out.push({ id: cal.id, label: cal.summaryOverride || cal.summary || '(unnamed)' });
    }
    return out;
  } catch (e) {
    console.warn('calendarList exception', e.message);
    return CALENDARS_FALLBACK;
  }
}

function formatTime(date, tz = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  const ap = parts.find(p => p.type === 'dayPeriod').value.toUpperCase();
  return m === '00' ? `${h} ${ap}` : `${h}:${m} ${ap}`;
}

// How many minutes off UTC is `date` when expressed in `tz`?
function tzOffsetMinutes(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = t => parseInt(parts.find(p => p.type === t).value, 10);
  let h = get('hour'); if (h === 24) h = 0;
  const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second'));
  return (localMs - date.getTime()) / 60000;
}

// Parse an ISO string. If it has an offset (or Z), trust it. If not, and a
// `tz` hint is provided, treat the string as a wall-clock time in that tz —
// Google sometimes returns offsetless dateTime when the event source (e.g.
// an iCal subscription) only declares a separate timeZone. Falling back to
// new Date() alone would cause wrong-by-N-hour bugs on UTC servers.
function parseEventInstant(iso, tz) {
  if (!iso) return null;
  const hasOffset = /[+-]\d\d:?\d\d$/.test(iso) || /Z$/.test(iso);
  if (hasOffset) return new Date(iso);
  if (!tz) return new Date(iso); // best effort
  // Wall-clock parsed as UTC, then shift by tz offset for that date
  const provisional = new Date(iso + 'Z');
  if (isNaN(provisional.getTime())) return new Date(iso);
  const offsetMin = tzOffsetMinutes(provisional, tz);
  return new Date(provisional.getTime() - offsetMin * 60 * 1000);
}

function formatTimeRange(startISO, endISO, tz = 'America/Chicago', startTz, endTz) {
  const s = parseEventInstant(startISO, startTz || tz);
  const e = parseEventInstant(endISO, endTz || tz);
  return `${formatTime(s, tz)} - ${formatTime(e, tz)}`;
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
    // invalid_grant = refresh token expired/revoked
    // unauthorized_client = client ID/secret mismatch or OAuth client is misconfigured
    // Both require the user to re-auth (after fixing config in the unauthorized_client case)
    const err = new Error('Failed to refresh Google access token: ' + JSON.stringify(data));
    if (data && (data.error === 'invalid_grant' || data.error === 'unauthorized_client')) {
      err.code = 'needs_reauth';
      err.oauthError = data.error;
    }
    throw err;
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

    // Determine time range: current month through +6 months (horizon view)
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 7, 0, 23, 59, 59).toISOString();

    const accessToken = await getAccessToken(refreshToken);

    // Discover calendars dynamically — when an iCal subscription is removed
    // and re-added on Google's side, the calendar gets a new ID. Hardcoded
    // IDs go stale. Listing the user's calendars at request time keeps us
    // current automatically.
    const calendars = await discoverCalendars(accessToken);

    // Fetch all calendars in parallel
    const results = await Promise.all(
      calendars.map(cal =>
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

      // Meeting URL: prefer conferenceData (Meet/Zoom/Teams video entry), then hangoutLink (legacy Meet)
      const videoEntry = ev.conferenceData?.entryPoints?.find(x => x.entryPointType === 'video');
      const meetingUrl = videoEntry?.uri || ev.hangoutLink || '';
      const description = ev.description || '';

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
            description,
            meetingUrl,
            startISO: `${dk}T06:00:00-05:00`,
            endISO: `${dk}T23:59:00-05:00`,
            cal: ev._calLabel,
            allDay: true,
          });
        }
      } else {
        // Pass through the event's own timeZone hints so offsetless dateTime
        // values (common on iCal-imported events) get parsed correctly.
        const startTz = ev.start.timeZone || null;
        const endTz = ev.end?.timeZone || startTz;
        const startMoment = parseEventInstant(startISO, startTz);
        const dk = dateKey(startMoment);
        if (!byDate[dk]) byDate[dk] = [];
        byDate[dk].push({
          id: ev.id || `${slugify(ev.summary)}-${dk}-${byDate[dk].length}`,
          summary: ev.summary || '(untitled)',
          time: formatTimeRange(startISO, endISO || startISO, 'America/Chicago', startTz, endTz),
          location: ev.location || '',
          description,
          meetingUrl,
          startISO,
          endISO: endISO || startISO,
          cal: ev._calLabel,
        });
      }
    }

    // Sort events per day by startISO
    for (const dk of Object.keys(byDate)) {
      byDate[dk].sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0));
    }

    // Debug mode: ?debug=1 — also returns raw start/end for the next 30 events
    // so we can verify what Google is actually sending (useful for diagnosing
    // wrong-time bugs from iCal-imported calendars).
    const debug = req.query?.debug === '1';
    const payload = {
      ok: true,
      synced_at: new Date().toISOString(),
      event_count: allEvents.length,
      by_date: byDate,
    };
    if (debug) {
      const todayKey = new Date().toISOString().slice(0, 10);
      payload.debug_events = allEvents
        .filter(ev => ev.start && (ev.start.dateTime || ev.start.date))
        .filter(ev => {
          const k = ev.start.dateTime ? ev.start.dateTime.slice(0,10) : ev.start.date;
          return k >= todayKey;
        })
        .slice(0, 30)
        .map(ev => ({
          summary: ev.summary,
          calendar: ev._calLabel,
          start: ev.start,
          end: ev.end,
          formatted_time: ev.start.dateTime
            ? formatTimeRange(ev.start.dateTime, ev.end?.dateTime || ev.start.dateTime, 'America/Chicago', ev.start.timeZone, ev.end?.timeZone)
            : 'All day',
        }));
    }
    // Hard no-cache so Vercel/CDN/browsers can't serve a stale response
    // when upstream Google data has changed.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).json(payload);
  } catch (e) {
    console.error('calendar fetch error', e);
    // Refresh token dead OR OAuth client misconfigured — surface as 412 so the client shows Reconnect
    if (e && e.code === 'needs_reauth') {
      const msg = e.oauthError === 'unauthorized_client'
        ? 'Google Calendar OAuth client misconfigured — reconnect to refresh credentials'
        : 'Google Calendar sign-in expired';
      return res.status(412).json({
        error: msg,
        oauthError: e.oauthError || null,
        action: 'Visit /api/google-auth to reconnect your calendar',
      });
    }
    res.status(500).json({ error: e.message });
  }
}
