// Health Q&A for the Daily Goals page. The page POSTs {question, history?}
// and we ask Claude for a friendly, evidence-based answer; the page persists
// the Q&A to Firestore itself. Needs ANTHROPIC_API_KEY in the Vercel env —
// without it we return 501 so the page saves the question as "open" instead
// of erroring at the user.
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from './_auth.js';

const SYSTEM = `You are the health assistant inside War Room, a personal planner. You answer the owner's everyday health and wellness questions — fitness, stretching and physical therapy habits, nutrition and home cooking, sleep, vitamins and supplements, hygiene, and routine-building.

Style:
- Lead with the answer in one or two sentences, then a few short bullets with the practical specifics (amounts, timing, technique).
- Ground advice in mainstream, evidence-based guidance; say plainly when evidence is mixed or weak.
- Use simple markdown only: **bold** for key numbers or terms, "-" bullets, numbered lists. No headers, no tables.
- Keep the whole answer compact — this renders in a small card on a phone.
- These are wellness questions, not diagnosis. Don't lecture or stack disclaimers; add one short "worth seeing a clinician" line only when the question involves red-flag symptoms, persistent pain, or medications.`;

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
      system: SYSTEM,
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
