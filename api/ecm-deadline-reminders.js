// Daily hard-deadline reminder for the ECM page.
//
// Flow: read the ECM Smartsheet + the `ecm_deadlines` hard-flags from
// Firestore, find open rows whose hard deadline is due soon (3d / 1d /
// today) or overdue, and post ONE digest comment on the Notion page
// "ECM Deadline Reminders" @mentioning the responsible people — Notion
// then delivers the email notification. Reminded items are stamped
// (lastRemindedDay) in Firestore so the cron never double-posts a day,
// while overdue items keep knocking daily until closed or unlocked.
//
// Runs from vercel.json crons at 13:00 UTC (8am Chicago in CDT). Manual
// trigger: GET /api/ecm-deadline-reminders?dryRun=1 with either the
// CRON_SECRET bearer or the x-team-token header — dryRun computes and
// returns the digest without posting or stamping.
//
// Env: SMARTSHEET_API_TOKEN + SMARTSHEET_SHEET_ID (already set for the
// team proxy), NOTION_TOKEN (internal integration with "insert comments";
// the reminders page must be shared with it), optional CRON_SECRET.
// The Notion page id + owner→Notion-user map live in Firestore
// `ecm_config/notion_reminders` so they're editable without a redeploy.

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/tv-todos/databases/(default)/documents';
const NOTION_VERSION = '2022-06-28';
const CLOSED_STATUSES = new Set(['Completed', 'Not feasible - close ticket']);

// ---- Firestore REST helpers (rules are open; no service account needed) ----
function fsDecode(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) {
    const out = {};
    Object.entries(v.mapValue.fields || {}).forEach(([k, x]) => { out[k] = fsDecode(x); });
    return out;
  }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsDecode);
  return v;
}
function fsDocToObj(doc) {
  const out = { _id: (doc.name || '').split('/').pop() };
  Object.entries(doc.fields || {}).forEach(([k, v]) => { out[k] = fsDecode(v); });
  return out;
}
async function fsList(collection) {
  const docs = [];
  let pageToken = '';
  do {
    const url = `${FS_BASE}/${collection}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`firestore list ${collection}: ${r.status}`);
    const j = await r.json();
    (j.documents || []).forEach(d => docs.push(fsDocToObj(d)));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}
async function fsGet(path) {
  const r = await fetch(`${FS_BASE}/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore get ${path}: ${r.status}`);
  return fsDocToObj(await r.json());
}
async function fsPatchField(path, field, stringValue) {
  const r = await fetch(`${FS_BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [field]: { stringValue } } })
  });
  if (!r.ok) throw new Error(`firestore patch ${path}: ${r.status}`);
}

// ---- Date helpers (everything runs on Chicago calendar days) ----
function chicagoTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dayDiff(fromISO, toISO) {
  // Whole days from `fromISO` to `toISO` (date-only strings, UTC-noon anchor
  // so DST can't skew the division).
  const a = Date.parse(fromISO + 'T12:00:00Z');
  const b = Date.parse(toISO + 'T12:00:00Z');
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}
function fmtDate(iso) {
  const t = Date.parse(iso + 'T12:00:00Z');
  if (!t) return iso;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default async function handler(req, res) {
  // Gate: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when the
  // env var is set; manual runs may use the team token header instead.
  const CRON_SECRET = process.env.CRON_SECRET || '';
  const TEAM_TOKEN = process.env.TEAM_ACCESS_TOKEN || '';
  const authHeader = (req.headers.authorization || '').toString();
  const teamHeader = (req.headers['x-team-token'] || '').toString();
  const cronOk = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const teamOk = TEAM_TOKEN && teamHeader === TEAM_TOKEN;
  if (!cronOk && !teamOk && CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const SS_TOKEN = process.env.SMARTSHEET_API_TOKEN || '';
  const SHEET_ID = process.env.SMARTSHEET_SHEET_ID || '';
  const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
  const dryRun = String(req.query.dryRun || '') === '1';
  if (!SS_TOKEN || !SHEET_ID) {
    res.status(500).json({ error: 'smartsheet_env_unset' });
    return;
  }

  // Overridable for local testing against a mock server.
  const SS_BASE = process.env.SMARTSHEET_BASE_URL || 'https://api.smartsheet.com/2.0';
  try {
    // 1) Sheet rows.
    const sr = await fetch(`${SS_BASE}/sheets/${SHEET_ID}`, {
      headers: { Authorization: `Bearer ${SS_TOKEN}`, Accept: 'application/json' }
    });
    if (!sr.ok) throw new Error(`smartsheet ${sr.status}`);
    const sheet = await sr.json();
    const colByTitle = {};
    (sheet.columns || []).forEach(c => { colByTitle[c.title] = c.id; });
    const dueColId = colByTitle['Due Date'] || colByTitle['Deadline'] || colByTitle['Target Date'];
    const cellVal = (row, colId) => {
      const c = (row.cells || []).find(x => x.columnId === colId);
      return c ? (c.displayValue ?? c.value ?? '') : '';
    };
    const rows = {};
    (sheet.rows || []).forEach(r => {
      rows[String(r.id)] = {
        id: String(r.id),
        task: cellVal(r, colByTitle['Task Name']),
        owner: cellVal(r, colByTitle['Owner']),
        status: cellVal(r, colByTitle['Status']),
        program: cellVal(r, colByTitle['Program']),
        ticket: String(cellVal(r, colByTitle['Ticket #']) || '').replace(/\.0$/, ''),
        due: String(dueColId ? cellVal(r, dueColId) : '').slice(0, 10),
        permalink: r.permalink || (sheet.permalink ? `${sheet.permalink}?rowId=${r.id}` : '')
      };
    });

    // 2) Hard flags + reminder config from Firestore.
    const [flags, cfg] = await Promise.all([
      fsList('ecm_deadlines'),
      fsGet('ecm_config/notion_reminders')
    ]);
    const pageId = cfg && cfg.pageId;
    const userMap = (cfg && cfg.userMap) || {};
    const fallbackUserId = (cfg && cfg.fallbackUserId) || '';
    const remindDaysBefore = Array.isArray(cfg && cfg.remindDaysBefore) && cfg.remindDaysBefore.length
      ? cfg.remindDaysBefore.map(Number) : [3, 1, 0];

    // 3) Which items knock today?
    const today = chicagoTodayISO();
    const due = [];
    const skipped = [];
    for (const f of flags) {
      if (!f.hard) continue;
      const r = rows[String(f.rowId || f._id)];
      if (!r) { skipped.push({ id: f._id, why: 'row gone from sheet' }); continue; }
      if (CLOSED_STATUSES.has(r.status)) { skipped.push({ id: f._id, why: 'closed' }); continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.due)) { skipped.push({ id: f._id, why: 'no due date' }); continue; }
      const daysLeft = dayDiff(today, r.due);
      const knock = daysLeft < 0 || remindDaysBefore.includes(daysLeft);
      if (!knock) continue;
      if (f.lastRemindedDay === today) { skipped.push({ id: f._id, why: 'already reminded today' }); continue; }
      due.push({ row: r, daysLeft, flagDocId: f._id });
    }

    if (!due.length) {
      res.json({ ok: true, today, reminded: 0, skipped });
      return;
    }
    // Overdue screams first, then nearest deadline.
    due.sort((a, b) => a.daysLeft - b.daysLeft);

    // 4) Build the digest comment. Mention each distinct Notion user once in
    // the header; per-item lines carry the owner name, deadline, and a link.
    const mentionIds = new Set();
    due.forEach(d => {
      const uid = userMap[d.row.owner] || userMap[(d.row.owner || '').split(/\s+/)[0]] || fallbackUserId;
      if (uid) mentionIds.add(uid);
    });
    const rt = [];
    const push = (content, annotations, link) => rt.push({
      type: 'text',
      text: { content, link: link ? { url: link } : null },
      ...(annotations ? { annotations } : {})
    });
    [...mentionIds].forEach(id => {
      rt.push({ type: 'mention', mention: { type: 'user', user: { object: 'user', id } } });
      push(' ');
    });
    push(`— ${due.length} hard deadline${due.length === 1 ? '' : 's'} need${due.length === 1 ? 's' : ''} attention (${fmtDate(today)}):\n`, { bold: true });
    due.forEach(d => {
      const r = d.row;
      const when = d.daysLeft < 0 ? `OVERDUE ${Math.abs(d.daysLeft)}d`
        : d.daysLeft === 0 ? 'DUE TODAY'
        : `due in ${d.daysLeft}d`;
      push(`\n${d.daysLeft <= 0 ? '🔴' : '🟠'} ${when} · `, { bold: d.daysLeft <= 0 });
      push(r.task || '(untitled)', { bold: true }, r.permalink || null);
      const bits = [r.owner || 'Unassigned', r.program, r.ticket ? `#${r.ticket}` : '', `due ${fmtDate(r.due)}`].filter(Boolean);
      push(` — ${bits.join(' · ')}`);
    });

    // 5) Post to Notion (skipped on dryRun or when the token isn't set yet).
    let notionPosted = false;
    let notionError = '';
    if (!dryRun && NOTION_TOKEN && pageId) {
      const nr = await fetch('https://api.notion.com/v1/comments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ parent: { page_id: pageId }, rich_text: rt })
      });
      if (nr.ok) notionPosted = true;
      else notionError = `notion ${nr.status}: ${(await nr.text().catch(() => '')).slice(0, 300)}`;
    } else if (!dryRun && !NOTION_TOKEN) {
      notionError = 'NOTION_TOKEN env var not set';
    }

    // 6) Stamp so a same-day rerun doesn't double-post. Only after a real post.
    if (notionPosted) {
      await Promise.all(due.map(d =>
        fsPatchField(`ecm_deadlines/${d.flagDocId}`, 'lastRemindedDay', today)
          .catch(e => console.warn('stamp failed', d.flagDocId, e.message))
      ));
    }

    res.json({
      ok: notionPosted || dryRun,
      today,
      dryRun,
      reminded: due.length,
      notionPosted,
      ...(notionError ? { notionError } : {}),
      items: due.map(d => ({ task: d.row.task, owner: d.row.owner, due: d.row.due, daysLeft: d.daysLeft })),
      skipped
    });
  } catch (e) {
    console.error('deadline reminders failed:', e);
    res.status(502).json({ error: 'reminder_run_failed', message: e.message });
  }
}
