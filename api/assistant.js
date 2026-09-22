// One function, three endpoints (two chats + read-only Notion). Vercel's Hobby plan caps a deployment at
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
5. Route every plan item to a SECTION of his page: "ecm" (GovTech consulting — ALWAYS for Smartsheet rows), "vitaltouch" (VitalTouch home-care business), "meals" (cooking, groceries, meal prep), "life" (everything else — personal, EZRK builds, BHA, errands, health).

RESPOND WITH ONLY THIS JSON — no markdown fences, no text outside it:
{"reply":"what you'd say to him — plain text, may use **bold** and \\n- bullets, keep it tight",
 "plan":[{"title":"task as it should appear","date":"YYYY-MM-DD","slot":"morning|afternoon|evening","source":"ecm|memory|new","section":"ecm|vitaltouch|meals|life","rowId":"only for source ecm — the [row N] id","memoryId":"only for source memory — the [mem X] id","note":"optional 3-6 word reason"}],
 "memory_add":["new unscheduled task text", "..."],
 "memory_resolve":[{"id":"mem doc id","why":"scheduled|done|dropped"}]}

JSON RULES:
- "plan" may be [] when he's just chatting. Every plan item MUST have a real date (today or later). Undated ideas belong in memory_add, not plan.
- Every plan item MUST carry "section". Items with a rowId are always section "ecm".
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
    .map(p => {
      const rowId = p.rowId && ecm.rowIds.has(String(p.rowId)) ? String(p.rowId) : null;
      // A real Smartsheet row is ECM work no matter what the model labeled it.
      const section = rowId ? 'ecm'
        : (['ecm', 'vitaltouch', 'meals', 'life'].includes(p.section) ? p.section : 'life');
      return {
        title: p.title.trim().slice(0, 200),
        date: String(p.date),
        slot: ['morning', 'afternoon', 'evening'].includes(p.slot) ? p.slot : null,
        source: ['ecm', 'memory', 'new'].includes(p.source) ? p.source : 'new',
        section,
        rowId,
        memoryId: p.memoryId && validMemIds.has(String(p.memoryId)) ? String(p.memoryId) : null,
        note: typeof p.note === 'string' ? p.note.slice(0, 80) : null
      };
    });

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

/* ============================== notion mode ==============================
   Read-only Notion for Personal's Notes — the ECM notes live there. POST
   {op:'search', q?, cursor?} → pages the integration can see, newest edits
   first; {op:'page', id} → one page as Markdown (Notes renders it with its
   sanitizing Markdown renderer). NOTION_TOKEN is an internal integration with
   "Read content"; it only sees pages shared with it. It never writes. */
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

function notionId(s) {
  const x = String(s || '').replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(x) ? x : '';
}
function notionUrl(id) { return 'https://www.notion.so/' + String(id).replace(/-/g, ''); }
async function notionCall(token, path, init) {
  const r = await fetch(NOTION_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VER, 'Content-Type': 'application/json' },
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error((j && j.message) || ('Notion ' + r.status));
    e.status = r.status; e.code = (j && j.code) || '';
    throw e;
  }
  return j || {};
}
function rtPlain(rt) { return (Array.isArray(rt) ? rt : []).map(t => (t && t.plain_text) || '').join(''); }
// Rich text → Markdown: bold / italic / strike / code / links.
function rtMd(rt) {
  return (Array.isArray(rt) ? rt : []).map(t => {
    let s = String((t && t.plain_text) || '');
    if (!s) return '';
    const a = t.annotations || {};
    if (a.code) s = '`' + s.replace(/`/g, "'") + '`';
    else {
      const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
      let core = m[2];
      if (core) {
        if (a.bold) core = '**' + core + '**';
        if (a.italic) core = '*' + core + '*';
        if (a.strikethrough) core = '~~' + core + '~~';
      }
      s = m[1] + core + m[3];
    }
    const href = t.href || (t.text && t.text.link && t.text.link.url) || '';
    if (href && /^https?:\/\//i.test(href)) s = '[' + s.replace(/[\[\]\n]/g, ' ') + '](' + href + ')';
    return s;
  }).join('');
}
function hEsc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function hUrl(u) { const x = String(u || '').trim(); return /^https?:\/\/[^\s"'<>`]{1,2000}$/i.test(x) ? x : ''; }
function hLink(u, inner) { const x = hUrl(u); return x ? `<a href="${hEsc(x)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner; }
// Rich text → HTML: every string escaped; links only http(s).
function rtHtml(rt) {
  return (Array.isArray(rt) ? rt : []).map(t => {
    let s = hEsc((t && t.plain_text) || '');
    if (!s) return '';
    const a = t.annotations || {};
    if (a.code) s = '<code>' + s + '</code>';
    if (a.bold) s = '<strong>' + s + '</strong>';
    if (a.italic) s = '<em>' + s + '</em>';
    if (a.strikethrough) s = '<s>' + s + '</s>';
    if (a.underline) s = '<u>' + s + '</u>';
    const href = t.href || (t.text && t.text.link && t.text.link.url) || '';
    return href ? hLink(href, s) : s;
  }).join('').replace(/\n/g, '<br>');
}
function pageTitle(p) {
  const props = (p && p.properties) || {};
  for (const k of Object.keys(props)) { const v = props[k]; if (v && v.type === 'title') return rtPlain(v.title).trim(); }
  return '';
}
function pageIcon(p) { return (p && p.icon && p.icon.type === 'emoji') ? p.icon.emoji : ''; }
function linkText(s) { return String(s || '').replace(/[\[\]\n]/g, ' ').trim() || 'link'; }

async function notionTable(token, id, budget) {
  if (budget.calls-- <= 0) return { md: '', html: '' };
  const j = await notionCall(token, '/blocks/' + id + '/children?page_size=100', { method: 'GET' });
  const cells = (j.results || []).filter(r => r.type === 'table_row').map(r => (r.table_row && r.table_row.cells) || []);
  if (!cells.length) return { md: '', html: '' };
  const n = Math.max(...cells.map(r => r.length));
  const fmt = r => '| ' + Array.from({ length: n }, (_, i) => (r[i] ? rtMd(r[i]).replace(/\|/g, '\\|').replace(/\n/g, ' ') : ' ')).join(' | ') + ' |';
  const md = [fmt(cells[0]), '| ' + Array(n).fill('---').join(' | ') + ' |', ...cells.slice(1).map(fmt)].join('\n');
  const tr = (r, tag) => '<tr>' + Array.from({ length: n }, (_, i) => `<${tag}>${r[i] ? rtHtml(r[i]) : ''}</${tag}>`).join('') + '</tr>';
  const html = '<table><thead>' + tr(cells[0], 'th') + '</thead><tbody>' + cells.slice(1).map(r => tr(r, 'td')).join('') + '</tbody></table>';
  return { md, html };
}
// A page's blocks → Markdown entries ({md, list}). Lists and a list's children
// sit on consecutive lines; everything else is its own paragraph. Nested
// content is read three levels deep, within a budget of API calls.
async function notionBlocks(token, id, depth, budget, out) {
  let cursor = null, num = 0;
  do {
    if (budget.calls-- <= 0) { out.push({ md: '*… more on the Notion page*', html: '<p><em>… more on the Notion page</em></p>', list: false }); budget.cut = true; return; }
    const q = '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const j = await notionCall(token, '/blocks/' + id + '/children' + q, { method: 'GET' });
    for (const b of (j.results || [])) {
      if (budget.cut) return;
      const t = b.type, v = b[t] || {}, ind = '  '.repeat(depth), text = rtMd(v.rich_text), th = rtHtml(v.rich_text);
      const li = (mark, cls) => `<div class="nl${cls ? ' ' + cls : ''}" style="--d:${depth}"><span class="nb">${mark}</span><div class="nt">${th || '&nbsp;'}</div></div>`;
      let md = null, html = null, list = false, kids = !!b.has_children && depth < 3, kidDepth = depth + 1;
      if (t !== 'numbered_list_item') num = 0;
      switch (t) {
        case 'paragraph': md = text ? ind + text : ''; html = th ? `<p style="--d:${depth}">${th}</p>` : ''; list = depth > 0; break;
        case 'heading_1': md = '# ' + text; html = '<h2>' + th + '</h2>'; break;
        case 'heading_2': md = '## ' + text; html = '<h3>' + th + '</h3>'; break;
        case 'heading_3': md = '### ' + text; html = '<h4>' + th + '</h4>'; break;
        case 'bulleted_list_item': md = ind + '- ' + text; html = li('•'); list = true; break;
        case 'numbered_list_item': num++; md = ind + num + '. ' + text; html = li(num + '.'); list = true; break;
        case 'to_do': md = ind + '- [' + (v.checked ? 'x' : ' ') + '] ' + text; html = li(v.checked ? '☑' : '☐', v.checked ? 'done' : ''); list = true; break;
        case 'toggle': md = ind + '- ' + text; html = li('▸'); list = true; break;
        case 'quote': md = '> ' + text; html = '<blockquote>' + th + '</blockquote>'; break;
        case 'callout': {
          const em = (v.icon && v.icon.emoji) ? v.icon.emoji + ' ' : '';
          md = '> ' + em + text; html = '<blockquote class="callout">' + hEsc(em) + th + '</blockquote>'; break;
        }
        case 'code': {
          const code = rtPlain(v.rich_text);
          md = '```' + String(v.language || '').replace(/[^\w+-]/g, '') + '\n' + code + '\n```'; html = '<pre><code>' + hEsc(code) + '</code></pre>'; kids = false; break;
        }
        case 'divider': md = '---'; html = '<hr>'; break;
        case 'equation': md = '`' + String(v.expression || '').replace(/`/g, "'") + '`'; html = '<p><code>' + hEsc(v.expression || '') + '</code></p>'; break;
        case 'child_page': case 'child_database': {
          const mark = t === 'child_page' ? '📄' : '🗂', ttl = v.title || (t === 'child_page' ? 'Untitled' : 'Database');
          md = ind + '- ' + mark + ' [' + linkText(ttl) + '](' + notionUrl(b.id) + ')';
          html = `<div class="nl" style="--d:${depth}"><span class="nb">${mark}</span><div class="nt">${hLink(notionUrl(b.id), hEsc(ttl))}</div></div>`;
          list = true; kids = false; break;
        }
        case 'image': case 'file': case 'pdf': case 'video': case 'audio': {
          const u = (v.external && v.external.url) || (v.file && v.file.url) || '';
          const cap = rtPlain(v.caption) || v.name || (t === 'image' ? 'Image' : t.toUpperCase());
          const mark = t === 'image' ? '🖼 ' : '📎 ';
          md = u ? ind + '[' + mark + linkText(cap) + '](' + u + ')' : null;
          html = u ? '<p>' + hLink(u, hEsc(mark + cap)) + '</p>' : null;
          list = depth > 0; break;
        }
        case 'bookmark': case 'embed': case 'link_preview': {
          const u = v.url || '', cap = rtPlain(v.caption) || u;
          md = /^https?:\/\//i.test(u) ? ind + '[' + linkText(cap) + '](' + u + ')' : null;
          html = hUrl(u) ? '<p>' + hLink(u, hEsc(cap)) + '</p>' : null;
          list = depth > 0; break;
        }
        case 'table': { const tb = await notionTable(token, b.id, budget); md = tb.md; html = tb.html; kids = false; break; }
        case 'column_list': case 'column': case 'synced_block': kidDepth = depth; break;   // their children carry it
        default: md = null;
      }
      if (md != null && md !== '') out.push({ md, html: html || '', list });
      if (kids) await notionBlocks(token, b.id, kidDepth, budget, out);
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
}
function notionJoin(out) {
  let s = '';
  out.forEach((e, i) => { s += (i === 0 ? '' : (e.list && out[i - 1].list ? '\n' : '\n\n')) + e.md; });
  return s;
}
async function handleNotion(req, res, body) {
  const token = process.env.NOTION_TOKEN || '';
  if (!token) { res.status(501).json({ error: 'notion_not_configured' }); return; }
  const op = String(body.op || '');
  try {
    if (op === 'search') {
      const payload = { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 30 };
      const q = String(body.q || '').trim().slice(0, 200);
      if (q) payload.query = q;
      if (body.cursor) payload.start_cursor = String(body.cursor).slice(0, 200);
      const j = await notionCall(token, '/search', { method: 'POST', body: JSON.stringify(payload) });
      const pages = (j.results || []).filter(p => p && p.object === 'page' && !p.archived && !p.in_trash).map(p => ({
        id: String(p.id).replace(/-/g, ''), title: pageTitle(p) || 'Untitled', icon: pageIcon(p),
        url: p.url || notionUrl(p.id), edited: p.last_edited_time || '',
      }));
      res.status(200).json({ pages, next: j.has_more ? j.next_cursor : null });
      return;
    }
    if (op === 'list') {
      // Databases this connection sees that carry a Program-like select and a
      // date (the ECM Meeting Notes): all their rows, newest date first.
      const budget = { calls: 14 };
      budget.calls--;
      const dj = await notionCall(token, '/search', { method: 'POST', body: JSON.stringify({ filter: { property: 'object', value: 'database' }, page_size: 50 }) });
      const notes = [], dbIds = new Set();
      for (const d of (dj.results || [])) {
        if (!d || d.archived || d.in_trash) continue;
        const props = d.properties || {}, keys = Object.keys(props);
        const progKey = keys.find(k => props[k].type === 'select' && /^(program|department|team|client)$/i.test(k.trim()));
        const dateKey = keys.find(k => props[k].type === 'date');
        if (!progKey || !dateKey) continue;
        const typeKey = keys.find(k => k !== progKey && props[k].type === 'select' && /^(type|kind|category)$/i.test(k.trim()));
        const sumKey = keys.find(k => props[k].type === 'rich_text' && /^(summary|tl;?dr|recap)$/i.test(k.trim()));
        const colors = {};
        (((props[progKey] || {}).select || {}).options || []).forEach(o => { colors[o.name] = o.color || 'default'; });
        const dbId = String(d.id).replace(/-/g, ''), dbTitle = rtPlain(d.title).trim();
        dbIds.add(dbId);
        let cursor = null;
        do {
          if (budget.calls-- <= 0) break;
          const body = { page_size: 100, sorts: [{ property: dateKey, direction: 'descending' }] };
          if (cursor) body.start_cursor = cursor;
          const q = await notionCall(token, '/databases/' + dbId + '/query', { method: 'POST', body: JSON.stringify(body) });
          for (const p of (q.results || [])) {
            if (!p || p.archived || p.in_trash) continue;
            const pr = p.properties || {};
            const sel = k => (k && pr[k] && pr[k].select) ? String(pr[k].select.name || '') : '';
            const prog = sel(progKey);
            notes.push({
              id: String(p.id).replace(/-/g, ''), title: pageTitle(p) || 'Untitled', icon: pageIcon(p),
              url: p.url || notionUrl(p.id), edited: p.last_edited_time || '', created: p.created_time || '',
              date: (pr[dateKey] && pr[dateKey].date && pr[dateKey].date.start) || '',
              program: prog, color: prog ? (colors[prog] || 'default') : '', type: sel(typeKey),
              summary: sumKey && pr[sumKey] ? rtPlain(pr[sumKey].rich_text).slice(0, 400) : '', db: dbTitle,
            });
          }
          cursor = q.has_more ? q.next_cursor : null;
        } while (cursor);
      }
      // Everything else the connection sees: program pages, docs — newest edits.
      const seen = new Set(notes.map(n => n.id));
      const sj = await notionCall(token, '/search', { method: 'POST', body: JSON.stringify({ filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100 }) });
      const others = (sj.results || []).filter(p => p && p.object === 'page' && !p.archived && !p.in_trash
          && !seen.has(String(p.id).replace(/-/g, ''))
          && !(p.parent && p.parent.type === 'database_id' && dbIds.has(String(p.parent.database_id).replace(/-/g, ''))))
        .map(p => ({ id: String(p.id).replace(/-/g, ''), title: pageTitle(p) || 'Untitled', icon: pageIcon(p), url: p.url || notionUrl(p.id), edited: p.last_edited_time || '' }));
      res.status(200).json({ notes, others });
      return;
    }
    if (op === 'page') {
      const id = notionId(body.id);
      if (!id) { res.status(400).json({ error: 'bad_id' }); return; }
      const p = await notionCall(token, '/pages/' + id, { method: 'GET' });
      const out = [];
      await notionBlocks(token, id, 0, { calls: 30, cut: false }, out);
      res.status(200).json({ id, title: pageTitle(p) || 'Untitled', icon: pageIcon(p), url: p.url || notionUrl(id), edited: p.last_edited_time || '', md: notionJoin(out).slice(0, 200000), html: out.map(e => e.html).join('').slice(0, 400000) });
      return;
    }
    res.status(400).json({ error: 'bad_op' });
  } catch (e) {
    // Notion's own 401 (a bad token) is not the War Room session: 502.
    const st = [403, 404, 429].includes(e.status) ? e.status : 502;
    res.status(st).json({ error: e.code || 'notion_error', message: String(e.message || '').slice(0, 300) });
  }
}

/* ============================ transcribe mode ============================
   Notes' 📷 Scan: a photo of a handwritten page (a journal, a notebook) →
   { date, markdown }. The writer's own words — cleaned, never rewritten. */
const TRANSCRIBE_SYSTEM = `You turn a photo of a handwritten page (usually a personal journal) into clean, readable text.

Faithful first:
- Transcribe the writer's own words, in their order. Never summarize, shorten, add, or reword.
- Fix only obvious misspellings and add punctuation or capitals where they are clearly intended.
- A word you can't read: [illegible]. A word you're unsure of: your best guess followed by [?].
- Leave out page furniture: printed headers, page numbers, stray marks and doodles.

Then lay it out well (Markdown):
- Paragraphs separated by one blank line — start a new one where the writer did, or where the thought clearly shifts. No walls of text.
- Lists stay lists: "- " for bullets, "1. " for numbered; to-dos with boxes as "- [ ] " (ticked: "- [x] ").
- A heading only where the page has one (a title or underlined heading line): "### ".
- Words the writer underlined or emphasized: **bold**.
- Don't put the entry's date in the text — return it separately.

If the entry is dated on the page, return that date as YYYY-MM-DD. A date written without a year takes the year that makes it the most recent such date that isn't in the future (today's date is given). No date on the page: null.

Also list the page's tasks:
Tasks — the concrete things the writer means to do:
- Explicit to-dos (unticked boxes, "need to", "have to", "remember to", "call…", "email…", "book…") and clear commitments.
- Not feelings, reflections, plans already done, ticked boxes, or vague wishes ("be healthier").
- Each one short and actionable, starting with a verb, in the writer's words (under 90 characters).
- On a to-do list, every item is a task — bare ones too ("Dry cleaning" → "Take the dry cleaning"). One line holding two separate jobs is two tasks.
- A due date only when the text gives one ("by Friday", "on the 30th") — resolve it against the date given. A date that covers a whole list ("So today, I need to…", "this week:") applies to every item on that list. Otherwise null.
- Every task, in the order they appear — never stop partway through the page (up to 40).

Reply with ONLY a JSON object: {"date": "YYYY-MM-DD" or null, "markdown": "…", "tasks": [{"text": "…", "due": "YYYY-MM-DD" or null}]}`;
async function handleTranscribe(req, res, body) {
  const img = typeof body.image === 'string' ? body.image.replace(/^data:[^,]*,/, '').trim() : '';
  const mt = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(body.mediaType) ? body.mediaType : 'image/jpeg';
  if (!img || img.length > 7000000 || !/^[A-Za-z0-9+/]+=*$/.test(img.slice(0, 4000).replace(/\s/g, '') + (img.length > 4000 ? '' : ''))) {
    res.status(400).json({ error: 'bad_image' });
    return;
  }
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today || '')) ? body.today : new Date().toISOString().slice(0, 10);
  let raw = '';
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 10000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: TRANSCRIBE_SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mt, data: img } },
        { type: 'text', text: `Today is ${today}. Transcribe this page.` },
      ] }],
    });
    if (response.stop_reason === 'refusal') { res.status(200).json({ error: 'refused' }); return; }
    raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    console.error('transcribe upstream error:', e);
    const status = e && Number.isInteger(e.status) ? e.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({ error: 'upstream_failed', message: e.message });
    return;
  }
  if (!raw) { res.status(502).json({ error: 'empty_answer' }); return; }
  // The JSON object; if the model wrapped it in prose or fences, find it.
  let date = null, markdown = '', tasks = [];
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    markdown = typeof j.markdown === 'string' ? j.markdown : '';
    tasks = cleanTasks(j.tasks, today);
    date = typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) && j.date <= today ? j.date : null;
  } catch {
    markdown = raw.replace(/^```[\w]*\n?|\n?```$/g, '');
  }
  markdown = markdown.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 40000);
  if (!markdown) { res.status(200).json({ error: 'nothing_read' }); return; }
  res.status(200).json({ date, markdown, tasks });
}
// The model's task list, kept to what the page can use.
function cleanTasks(list, today) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map(t => ({
    text: String((t && t.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    due: (t && typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) && t.due >= '2000-01-01') ? t.due : null,
  })).filter(t => {
    const k = t.text.toLowerCase();
    if (!t.text || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 40);
}

/* ============================== tasks mode ==============================
   Notes' ✦ Suggest tasks: a note's text (or one journal day) → the to-dos in
   it, for the user to pick from. Nothing is created here. */
const TASKS_SYSTEM = `You read a personal note or journal entry and pick out the tasks in it.

Tasks — the concrete things the writer means to do:
- Explicit to-dos (unticked boxes, "need to", "have to", "remember to", "call…", "email…", "book…") and clear commitments.
- Not feelings, reflections, plans already done, ticked boxes, or vague wishes ("be healthier").
- Each one short and actionable, starting with a verb, in the writer's words (under 90 characters).
- On a to-do list, every item is a task — bare ones too ("Dry cleaning" → "Take the dry cleaning"). One line holding two separate jobs is two tasks.
- A due date only when the text gives one ("by Friday", "on the 30th") — resolve it against the date given. A date that covers a whole list ("So today, I need to…", "this week:") applies to every item on that list. Otherwise null.
- Every task, in the order they appear — never stop partway through the page (up to 40).
- Skip anything listed under "Already tasks".

Reply with ONLY a JSON object: {"tasks": [{"text": "…", "due": "YYYY-MM-DD" or null}]} — an empty list when there are none.`;
async function handleTasks(req, res, body) {
  const text = String(body.text || '').slice(0, 24000).trim();
  if (!text) { res.status(400).json({ error: 'no_text' }); return; }
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today || '')) ? body.today : new Date().toISOString().slice(0, 10);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : '';
  const title = String(body.title || '').slice(0, 200);
  const existing = (Array.isArray(body.existing) ? body.existing : []).map(x => String(x || '').slice(0, 200)).filter(Boolean).slice(0, 80);
  let raw = '';
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 5000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: TASKS_SYSTEM,
      messages: [{ role: 'user', content:
        `Today is ${today}.${dated ? ` This entry is from ${dated}.` : ''}${title ? ` Note: "${title}".` : ''}\n`
        + (existing.length ? `Already tasks:\n${existing.map(x => '- ' + x).join('\n')}\n` : '')
        + `\n<note>\n${text}\n</note>` }],
    });
    if (response.stop_reason === 'refusal') { res.status(200).json({ error: 'refused' }); return; }
    raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    console.error('tasks upstream error:', e);
    const status = e && Number.isInteger(e.status) ? e.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({ error: 'upstream_failed', message: e.message });
    return;
  }
  let tasks = [];
  try { const m = raw.match(/\{[\s\S]*\}/); tasks = cleanTasks(JSON.parse(m ? m[0] : raw).tasks, today); } catch {}
  res.status(200).json({ tasks });
}

/* ============================== shared gates ============================== */

export default async function handler(req, res) {
  const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const qMode = (req.query && req.query.mode || '').toString();
  // The ECM page's team link (no War Room login) may READ Notion — nothing
  // else here. Same header and env var as the Smartsheets team proxy.
  const TEAM_TOKEN = process.env.TEAM_ACCESS_TOKEN || '';
  const teamHeader = (req.headers['x-team-token'] || '').toString();
  const isTeam = qMode === 'notion' && !!TEAM_TOKEN && teamHeader.length === TEAM_TOKEN.length && teamHeader === TEAM_TOKEN;
  if (!isTeam && !requireAuth(req, SESSION_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const mode = (req.query && req.query.mode || '').toString();
  if (mode === 'notion') return handleNotion(req, res, body);   // no Claude involved

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(501).json({ error: 'not_configured' });
    return;
  }
  if (mode === 'plan') return handlePlan(req, res, body);
  if (mode === 'transcribe') return handleTranscribe(req, res, body);
  if (mode === 'tasks') return handleTasks(req, res, body);
  return handleHealth(req, res, body);
}
