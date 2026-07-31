// One function, two chat endpoints. Vercel's Hobby plan caps a deployment at
// 12 serverless functions and this repo sits exactly at the cap, so the
// Daily-Goals health Q&A and the Personal-page planning coach share this
// file. vercel.json rewrites keep the semantic URLs the pages already call:
//   /api/health-chat → /api/assistant?mode=health
//   /api/plan-chat   → /api/assistant?mode=plan
// Shared gates (cookie auth, POST-only, 501 without ANTHROPIC_API_KEY) run
// once in the default export; each mode keeps its original behavior below.
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from './_auth.js';

/* ======================= health mode (was health-chat.js) =======================
   The Daily Goals page POSTs {question, history?} and we ask Claude for a
   friendly, evidence-based answer; the page persists the Q&A to Firestore
   itself. */

const HEALTH_SYSTEM = `You are the health assistant inside War Room, a personal planner. You answer the owner's everyday health and wellness questions — fitness, stretching and physical therapy habits, nutrition and home cooking, sleep, vitamins and supplements, hygiene, and routine-building.

Style:
- Lead with the answer in one or two sentences, then a few short bullets with the practical specifics (amounts, timing, technique).
- Ground advice in mainstream, evidence-based guidance; say plainly when evidence is mixed or weak.
- Use simple markdown only: **bold** for key numbers or terms, "-" bullets, numbered lists. No headers, no tables.
- Keep the whole answer compact — this renders in a small card on a phone.
- These are wellness questions, not diagnosis. Don't lecture or stack disclaimers; add one short "worth seeing a clinician" line only when the question involves red-flag symptoms, persistent pain, or medications.`;

async function handleHealth(req, res, body) {
  const question = (body.question || '').toString().trim().slice(0, 2000);
  if (!question) {
    res.status(400).json({ error: 'missing_question' });
    return;
  }

  // Up to 3 prior Q&A pairs so follow-ups ("what about at night?") make sense.
  const messages = [];
  for (const h of (Array.isArray(body.history) ? body.history.slice(-3) : [])) {
    if (h && h.q && h.a) {
      messages.push({ role: 'user', content: String(h.q).slice(0, 2000) });
      messages.push({ role: 'assistant', content: String(h.a).slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: question });

  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1500,
      output_config: { effort: 'low' },
      // Safety classifiers can decline benign-adjacent requests; the server-side
      // fallback re-runs those on Anthropic's recommended model instead of
      // surfacing a refusal to the user.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: HEALTH_SYSTEM,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      res.status(200).json({ error: 'refused' });
      return;
    }
    const text = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    if (!text) {
      res.status(502).json({ error: 'empty_answer' });
      return;
    }
    res.status(200).json({ answer: text });
  } catch (e) {
    console.error('health-chat error:', e);
    const status = e && Number.isInteger(e.status) ? e.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({ error: 'upstream_failed', message: e.message });
  }
}

/* ======================== plan mode (was plan-chat.js) ========================
   Planning coach for the Personal page. The page POSTs {message, history?,
   personal?} — `personal` is a client-assembled snapshot of the user's lists,
   planned items, day blocks, and calendar. The server enriches that with live
   ECM work (Smartsheet rows assigned to the owner, deadlines, stars,
   priorities) and the `coach_memory` backlog of tasks the user has mentioned
   in past conversations, then asks Claude for either a chat reply or a
   structured day/week plan proposal.

   Response: { reply, plan:[{title,date,slot,source,rowId,note}], memory:[...],
   historyEntry }. Plan items are PROPOSALS — the page renders them with
   checkboxes and only writes todos when the user accepts. Memory adds and
   resolves returned by the model are persisted here (Firestore REST, open
   rules) so a brain-dumped task survives even if the user closes the sheet
   right after talking.

   SMARTSHEET_API_TOKEN + SMARTSHEET_SHEET_ID + SMARTSHEET_OWNER_NAME make the
   ECM section work; if they're missing or the fetch fails we still answer,
   just without ECM context. SMARTSHEET_BASE_URL overrides for mock testing. */

// ---- Firestore REST helpers (mirror api/ecm-deadline-reminders.js) ----
const FS_BASE = 'https://firestore.googleapis.com/v1/projects/tv-todos/databases/(default)/documents';
const CLOSED_STATUSES = new Set(['Completed', 'Not feasible - close ticket']);

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
async function fsCreate(collection, fields) {
  const r = await fetch(`${FS_BASE}/${collection}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error(`firestore create ${collection}: ${r.status}`);
  const j = await r.json();
  return (j.name || '').split('/').pop();
}
async function fsPatchFields(path, obj) {
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: obj })
  });
  if (!r.ok) throw new Error(`firestore patch ${path}: ${r.status}`);
}
const fsStr = s => ({ stringValue: String(s) });

// ---- Date helpers (Chicago calendar days, same as the reminder cron) ----
function chicagoTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dayDiff(fromISO, toISO) {
  const a = Date.parse(fromISO + 'T12:00:00Z');
  const b = Date.parse(toISO + 'T12:00:00Z');
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}
function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

// ---- ECM context: sheet rows worth planning around ----
// Open rows that are assigned to the owner, dated, hard-flagged, starred, or
// linked from a team priority. Returns compact lines + the set of valid row
// ids so hallucinated rowIds can be stripped from proposals.
async function buildEcmContext() {
  const SS_TOKEN = process.env.SMARTSHEET_API_TOKEN || '';
  const SHEET_ID = process.env.SMARTSHEET_SHEET_ID || '';
  const OWNER = process.env.SMARTSHEET_OWNER_NAME || '';
  if (!SS_TOKEN || !SHEET_ID) return { text: '(ECM not configured)', rowIds: new Set() };

  const SS_BASE = process.env.SMARTSHEET_BASE_URL || 'https://api.smartsheet.com/2.0';
  const sr = await fetch(`${SS_BASE}/sheets/${SHEET_ID}`, {
    headers: { Authorization: `Bearer ${SS_TOKEN}`, Accept: 'application/json' }
  });
  if (!sr.ok) throw new Error(`smartsheet ${sr.status}`);
  const sheet = await sr.json();
  const colByTitle = {};
  (sheet.columns || []).forEach(c => { colByTitle[c.title] = c.id; });
  const dueColId = colByTitle['Due Date'] || colByTitle['Deadline'] || colByTitle['Target Date'];
  const delColId = colByTitle['Marked for Deletion'];
  const cellVal = (row, colId) => {
    const c = (row.cells || []).find(x => x.columnId === colId);
    return c ? (c.displayValue ?? c.value ?? '') : '';
  };
  const rows = {};
  (sheet.rows || []).forEach(r => {
    if (delColId && cellVal(r, delColId) === true) return;
    const status = cellVal(r, colByTitle['Status']);
    if (CLOSED_STATUSES.has(status)) return;
    rows[String(r.id)] = {
      id: String(r.id),
      task: cellVal(r, colByTitle['Task Name']),
      owner: cellVal(r, colByTitle['Owner']),
      status,
      program: cellVal(r, colByTitle['Program']),
      due: String(dueColId ? cellVal(r, dueColId) : '').slice(0, 10)
    };
  });

  const [flags, stars, priorities] = await Promise.all([
    fsList('ecm_deadlines').catch(() => []),
    fsList('ecm_stars').catch(() => []),
    fsList('ecm_priorities').catch(() => [])
  ]);
  const hardIds = new Set(flags.filter(f => f.hard).map(f => String(f.rowId || f._id)));
  const starById = {};
  stars.forEach(s => { starById[String(s.rowId || s._id)] = s; });
  const prioByRow = {};
  priorities.forEach(p => (Array.isArray(p.rowIds) ? p.rowIds : []).forEach(rid => {
    prioByRow[String(rid)] = p;
  }));

  const today = chicagoTodayISO();
  const candidates = [];
  for (const r of Object.values(rows)) {
    const star = starById[r.id];
    const prio = prioByRow[r.id];
    const mine = OWNER && r.owner === OWNER;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(r.due) ? r.due : (star && /^\d{4}-\d{2}-\d{2}$/.test(String(star.due || '')) ? String(star.due) : '');
    if (!mine && !due && !hardIds.has(r.id) && !star && !prio) continue;
    const daysLeft = due ? dayDiff(today, due) : null;
    // Keep the far future out of the prompt: undated signals always show,
    // dated ones only inside a 3-week planning horizon.
    if (daysLeft !== null && daysLeft > 21) continue;
    candidates.push({ r, due, daysLeft, mine, hard: hardIds.has(r.id), star, prio });
  }
  candidates.sort((a, b) => {
    const ad = a.daysLeft === null ? 999 : a.daysLeft;
    const bd = b.daysLeft === null ? 999 : b.daysLeft;
    return ad - bd;
  });

  const lines = candidates.slice(0, 40).map(c => {
    const bits = [c.r.program, c.r.owner ? `owner ${c.r.owner}` : '', c.r.status];
    if (c.due) {
      bits.push(`due ${c.due} (${c.daysLeft < 0 ? `OVERDUE ${Math.abs(c.daysLeft)}d` : c.daysLeft === 0 ? 'TODAY' : `in ${c.daysLeft}d`})`);
    }
    if (c.hard) bits.push('HARD DEADLINE');
    if (c.star) bits.push(c.star.note ? `starred: "${String(c.star.note).slice(0, 80)}"` : 'starred');
    if (c.prio && c.prio.text) bits.push(`team priority: "${String(c.prio.text).slice(0, 80)}"`);
    if (c.mine) bits.push('ASSIGNED TO ME');
    return `- [row ${c.r.id}] ${c.r.task || '(untitled)'} — ${bits.filter(Boolean).join(' · ')}`;
  });
  // Standalone team priorities with no linked row still matter for the week.
  priorities.filter(p => p.text && !(Array.isArray(p.rowIds) && p.rowIds.length) && !p.archived && !p.done)
    .slice(0, 10)
    .forEach(p => lines.push(`- [no row] Team priority${p.program ? ` (${p.program})` : ''}: "${String(p.text).slice(0, 100)}"${p.due ? ` — due ${p.due}` : ''}`));

  return {
    text: lines.length ? lines.join('\n') : '(nothing urgent, assigned, or flagged right now)',
    rowIds: new Set(candidates.map(c => c.r.id))
  };
}

async function loadCoachMemory() {
  const docs = await fsList('coach_memory').catch(() => []);
  return docs
    .filter(d => (d.status || 'open') === 'open' && d.text)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 30);
}

// ---- Personal snapshot → prompt text (client sends structured, we flatten) ----
function personalToText(p) {
  if (!p || typeof p !== 'object') return '(no snapshot sent)';
  const out = [];
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
  if (Array.isArray(p.tasks) && p.tasks.length) {
    out.push('Current task lists:');
    cap(p.tasks, 40).forEach(t => out.push(`- [${t.list || 'Tasks'}] ${String(t.text || '').slice(0, 120)}${t.done ? ' (done)' : ''}`));
  } else out.push('Current task lists: (empty)');
  if (Array.isArray(p.planned) && p.planned.length) {
    out.push('Planned (parked for a date):');
    cap(p.planned, 30).forEach(t => out.push(`- ${String(t.text || '').slice(0, 120)}${t.date ? ` — ${t.date}` : ' — undated'}${t.ecm ? ' [ECM]' : ''}`));
  }
  if (Array.isArray(p.calendar) && p.calendar.length) {
    out.push('Calendar (next 7 days):');
    cap(p.calendar, 30).forEach(e => out.push(`- ${e.date || ''} ${e.time || ''} ${String(e.summary || '').slice(0, 80)}`.trim()));
  }
  if (Array.isArray(p.dayBlocks) && p.dayBlocks.length) {
    out.push('Time blocks already scheduled:');
    cap(p.dayBlocks, 20).forEach(b => out.push(`- ${b.date || ''} ${b.start || ''}-${b.end || ''} ${String(b.label || '').slice(0, 60)}`.trim()));
  }
  return out.join('\n');
}

function planSystemPrompt({ today, ecmText, memoryDocs, personalText }) {
  const memText = memoryDocs.length
    ? memoryDocs.map(m => `- [mem ${m._id}] ${String(m.text).slice(0, 120)}${m.createdAt ? ` (mentioned ${String(m.createdAt).slice(0, 10)})` : ''}`).join('\n')
    : '(nothing pending)';
  return `You are If's planning coach inside War Room, his personal planner. He talks (often via speech-to-text, so expect rambly run-on phrasing) and you turn it into concrete day and week plans. Be direct and sharp, like a smart chief of staff. Never use emojis.

WHO HE IS:
- Runs ECM (GovTech consulting, roughly 9am-5pm CT weekdays), EZRK Apps (evening/weekend builds), VitalTouch (home care business), BHA, plus personal life.
- Deep work in the morning beats admin. Evenings/weekends are for builds and personal tasks, not ECM.

TODAY: ${weekdayOf(today)}, ${today} (America/Chicago).

HIS PERSONAL PAGE RIGHT NOW:
${personalText}

ECM WORK (assigned to him, deadlines, starred, team priorities):
${ecmText}

TASKS HE MENTIONED BEFORE THAT ARE STILL UNSCHEDULED (coach memory):
${memText}

YOUR JOB:
1. If he asks to plan a day: propose 5-9 items for that date, ordered, realistic. If he asks to plan the week: spread items over the next 5-7 days around his calendar. If he's brain-dumping or chatting: answer briefly, and capture any new tasks.
2. Pull from ALL four sources: what he just said, his existing lists, ECM work (prefer overdue, due soon, hard deadlines, assigned-to-me), and coach memory. Say why an ECM item made the cut.
3. Anything he mentions that does NOT get scheduled right now goes into memory adds so it resurfaces next time. When a memory item gets scheduled or he says it's done/irrelevant, resolve it.
4. Never propose items that already sit in his task lists or planned parking — those are shown above. Suggest at most what fits; he can always ask for more.

RESPOND WITH ONLY THIS JSON — no markdown fences, no text outside it:
{"reply":"what you'd say to him — plain text, may use **bold** and \\n- bullets, keep it tight",
 "plan":[{"title":"task as it should appear","date":"YYYY-MM-DD","slot":"morning|afternoon|evening","source":"ecm|memory|new","rowId":"only for source ecm — the [row N] id","memoryId":"only for source memory — the [mem X] id","note":"optional 3-6 word reason"}],
 "memory_add":["new unscheduled task text", "..."],
 "memory_resolve":[{"id":"mem doc id","why":"scheduled|done|dropped"}]}

JSON RULES:
- "plan" may be [] when he's just chatting. Every plan item MUST have a real date (today or later). Undated ideas belong in memory_add, not plan.
- rowId must be copied exactly from a [row N] line above; memoryId from a [mem X] line. Never invent ids.
- memory_resolve with why:"scheduled" is REQUIRED for every memory item you put in the plan.
- Keep "reply" under 120 words; the plan speaks for itself.`;
}

// Pull the model's JSON out even if it wrapped it in prose or fences.
function parseModelJSON(raw) {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

async function handlePlan(req, res, body) {
  const message = (body.message || '').toString().trim().slice(0, 4000);
  if (!message) {
    res.status(400).json({ error: 'missing_message' });
    return;
  }

  // Context assembly is best-effort: a Smartsheet or Firestore hiccup should
  // degrade to a context-less chat, not a 500.
  const today = chicagoTodayISO();
  let ecm = { text: '(ECM temporarily unavailable)', rowIds: new Set() };
  let memoryDocs = [];
  try { ecm = await buildEcmContext(); } catch (e) { console.warn('plan-chat ecm context failed:', e.message); }
  try { memoryDocs = await loadCoachMemory(); } catch (e) { console.warn('plan-chat memory load failed:', e.message); }
  const personalText = personalToText(body.personal);

  const messages = [];
  for (const h of (Array.isArray(body.history) ? body.history.slice(-8) : [])) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      messages.push({ role: h.role, content: String(h.content).slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: message });

  let raw;
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      output_config: { effort: 'medium' },
      // Same fallback contract as health mode: benign-adjacent declines rerun
      // on the recommended model instead of surfacing a refusal.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: planSystemPrompt({ today, ecmText: ecm.text, memoryDocs, personalText }),
      messages,
    });
    if (response.stop_reason === 'refusal') {
      res.status(200).json({ error: 'refused' });
      return;
    }
    raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    console.error('plan-chat upstream error:', e);
    const status = e && Number.isInteger(e.status) ? e.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({ error: 'upstream_failed', message: e.message });
    return;
  }
  if (!raw) {
    res.status(502).json({ error: 'empty_answer' });
    return;
  }

  const parsed = parseModelJSON(raw);
  if (!parsed || typeof parsed.reply !== 'string') {
    // Model ignored the protocol — still give the user the text.
    res.status(200).json({ reply: raw, plan: [], memory: memoryDocs.map(m => ({ id: m._id, text: m.text })), historyEntry: raw });
    return;
  }

  // Sanitize the plan: real titles, real dates, only ids we actually showed.
  const validMemIds = new Set(memoryDocs.map(m => m._id));
  const plan = (Array.isArray(parsed.plan) ? parsed.plan : [])
    .filter(p => p && typeof p.title === 'string' && p.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')))
    .slice(0, 40)
    .map(p => ({
      title: p.title.trim().slice(0, 200),
      date: String(p.date),
      slot: ['morning', 'afternoon', 'evening'].includes(p.slot) ? p.slot : null,
      source: ['ecm', 'memory', 'new'].includes(p.source) ? p.source : 'new',
      rowId: p.rowId && ecm.rowIds.has(String(p.rowId)) ? String(p.rowId) : null,
      memoryId: p.memoryId && validMemIds.has(String(p.memoryId)) ? String(p.memoryId) : null,
      note: typeof p.note === 'string' ? p.note.slice(0, 80) : null
    }));

  // Persist memory changes server-side so a brain-dump can't be lost by
  // closing the sheet. Dedupe adds against open items (case-insensitive).
  const openNorm = new Set(memoryDocs.map(m => String(m.text).trim().toLowerCase()));
  const nowIso = new Date().toISOString();
  const added = [];
  for (const t of (Array.isArray(parsed.memory_add) ? parsed.memory_add : []).slice(0, 15)) {
    const text = String(t || '').trim().slice(0, 200);
    if (!text || openNorm.has(text.toLowerCase())) continue;
    openNorm.add(text.toLowerCase());
    try {
      const id = await fsCreate('coach_memory', {
        text: fsStr(text), status: fsStr('open'), source: fsStr('coach'),
        createdAt: fsStr(nowIso)
      });
      added.push({ _id: id, text, createdAt: nowIso });
    } catch (e) { console.warn('coach_memory add failed:', e.message); }
  }
  const resolvedIds = new Set();
  for (const r of (Array.isArray(parsed.memory_resolve) ? parsed.memory_resolve : []).slice(0, 30)) {
    const id = r && String(r.id || '');
    if (!validMemIds.has(id)) continue;
    const why = ['scheduled', 'done', 'dropped'].includes(r.why) ? r.why : 'scheduled';
    try {
      await fsPatchFields(`coach_memory/${id}`, {
        status: fsStr(why === 'scheduled' ? 'scheduled' : why),
        resolvedAt: fsStr(nowIso)
      });
      resolvedIds.add(id);
    } catch (e) { console.warn('coach_memory resolve failed:', e.message); }
  }
  const memoryOut = [...memoryDocs.filter(m => !resolvedIds.has(m._id)), ...added]
    .map(m => ({ id: m._id, text: m.text }));

  // Compact assistant turn for the client to feed back as history — the reply
  // plus a one-line proposal summary, so follow-ups can reference the plan
  // without re-sending its JSON.
  const historyEntry = parsed.reply + (plan.length
    ? `\n[Proposed: ${plan.map(p => `${p.title} → ${p.date}`).join('; ').slice(0, 1500)}]`
    : '');

  res.status(200).json({ reply: parsed.reply, plan, memory: memoryOut, historyEntry });
}

/* ============================== shared gates ============================== */

export default async function handler(req, res) {
  const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
  if (!requireAuth(req, SESSION_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(501).json({ error: 'not_configured' });
    return;
  }

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const mode = (req.query && req.query.mode || '').toString();
  if (mode === 'plan') return handlePlan(req, res, body);
  return handleHealth(req, res, body);
}
