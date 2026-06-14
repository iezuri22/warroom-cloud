import { requireAuth } from './_auth.js';

// Pulls recipes from the EZ recipe app's Supabase project and returns them in
// the shape the Meals tracker expects: { recipes: [{ title, url, img, tags, notes }] }.
//
// Required Vercel env vars (add in Project Settings > Environment Variables):
//   SUPABASE_URL        e.g. https://xxxx.supabase.co
//   SUPABASE_KEY        a Supabase key with read access to the recipes table
//                       (anon key is fine if RLS allows select; otherwise service role)
// Optional:
//   EZ_RECIPES_TABLE    table name (default: "recipes")
//
// Column names are mapped flexibly below — adjust the fallbacks if your schema differs.

function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return '';
}
function toTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(',').map(x => x.trim()).filter(Boolean);
}

export default async function handler(req, res) {
  const secret = process.env.SESSION_SECRET;
  if (!requireAuth(req, secret)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const table = process.env.EZ_RECIPES_TABLE || 'recipes';

  if (!base || !key) {
    return res.status(501).json({
      error: 'not_configured',
      detail: 'Set SUPABASE_URL and SUPABASE_KEY (and optionally EZ_RECIPES_TABLE) in Vercel env vars to enable EZ recipe pull.'
    });
  }

  try {
    const url = `${base.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}?select=*&limit=500`;
    const r = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: 'supabase_error', status: r.status, detail: text.slice(0, 300) });
    }
    const rows = await r.json();
    const recipes = (Array.isArray(rows) ? rows : []).map(row => ({
      title: pick(row, ['title', 'name', 'recipe_name']),
      url: pick(row, ['url', 'link', 'source_url', 'web_url']),
      img: pick(row, ['image', 'image_url', 'img', 'photo', 'photo_url', 'thumbnail']),
      tags: toTags(pick(row, ['tags', 'category', 'categories', 'cuisine'])),
      notes: pick(row, ['notes', 'description', 'summary'])
    })).filter(x => x.title);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ recipes });
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', detail: (e && e.message) ? e.message.slice(0, 300) : 'unknown' });
  }
}
