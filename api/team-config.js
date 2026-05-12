// Tiny bootstrap endpoint for team-mode ECM access. The team's browser
// doesn't know the Smartsheets sheet ID or owner name — those are configured
// server-side via env vars. Browser presents the team token, server returns
// just enough to populate ecm.html's in-memory config.
//
// GET /api/team-config
//   x-team-token: <TEAM_ACCESS_TOKEN env var>
//   → { sheetId: "12345", owner: "Ifeanyi" }
export default async function handler(req, res) {
  const TEAM_TOKEN = process.env.TEAM_ACCESS_TOKEN || '';
  const SHEET_ID   = process.env.SMARTSHEET_SHEET_ID || '';
  const OWNER      = process.env.SMARTSHEET_OWNER_NAME || '';
  const teamHeader = (req.headers['x-team-token'] || '').toString();
  if (!TEAM_TOKEN || !teamHeader || teamHeader !== TEAM_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!SHEET_ID) {
    res.status(500).json({ error: 'sheet_id_unset' });
    return;
  }
  res.status(200).json({ sheetId: SHEET_ID, owner: OWNER });
}
