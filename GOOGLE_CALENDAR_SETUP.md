# Google Calendar Real-Time Sync — Setup

One-time setup (~10 min). After this, the Sync button in War Room pulls live data from Google in ~1 second.

---

## Step 1 — Create OAuth credentials (5 min)

1. Go to https://console.cloud.google.com/
2. Top bar → **Select a project** → **New Project**
   - Name: `warroom-calendar` (or whatever)
   - Click Create, then select that project
3. Left menu → **APIs & Services** → **Library**
   - Search "Google Calendar API" → click it → **Enable**
4. Left menu → **APIs & Services** → **OAuth consent screen**
   - User Type: **External** → Create
   - App name: `War Room`
   - User support email: your email
   - Developer email: your email
   - Save and Continue
   - Scopes: Skip (leave blank) → Save and Continue
   - Test users: Add your Gmail (`iezuri22@gmail.com`) → Save and Continue
   - Back to dashboard
5. Left menu → **APIs & Services** → **Credentials** → **+ CREATE CREDENTIALS** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `War Room Web`
   - Authorized redirect URIs: click **+ ADD URI** and paste:
     ```
     https://warroom-cloud.vercel.app/api/google-callback
     ```
   - Click Create
6. A popup shows your **Client ID** and **Client Secret**. Copy both. You'll need them in Step 2.

---

## Step 2 — Add credentials to Vercel (2 min)

1. Go to https://vercel.com/ → your `warroom-cloud` project
2. **Settings** → **Environment Variables**
3. Add two variables:
   - Name: `GOOGLE_CLIENT_ID`, Value: (paste the Client ID from Step 1.6)
   - Name: `GOOGLE_CLIENT_SECRET`, Value: (paste the Client Secret from Step 1.6)
4. Make sure both apply to Production, Preview, and Development
5. Click Save

**Important**: after saving env vars, Vercel requires a redeploy to pick them up. Either push a new commit OR go to Deployments tab → ••• → Redeploy.

---

## Step 3 — Connect your Google account (1 min)

1. Visit this URL in your browser (make sure you're logged into War Room first):
   ```
   https://warroom-cloud.vercel.app/api/google-auth
   ```
2. Google will ask you to sign in with `iezuri22@gmail.com`
3. You'll see a warning "Google hasn't verified this app" — click **Advanced** → **Go to War Room (unsafe)**. This is expected for personal/test apps.
4. Click **Allow** to grant read-only calendar access
5. You'll be redirected to a page that says "✓ Google Calendar connected"
6. Tap "Back to War Room"

---

## Step 4 — Test it

1. Open War Room, go to the Cal sidebar
2. Tap the circular arrow (sync) icon in the sidebar header
3. You should see "✓ N events" flash at the bottom right
4. Add a new event to Google Calendar on your phone
5. Tap the sync button again — new event shows within 1 second

---

## Troubleshooting

**"GOOGLE_CLIENT_ID not configured"** → You didn't add the env vars, OR Vercel didn't redeploy after adding them. Go to Vercel → Deployments → Redeploy latest.

**"Google hasn't verified this app"** → Expected. Click Advanced → Continue. This only matters if you were making the app public, which you're not.

**"No refresh_token returned"** → Revoke access at https://myaccount.google.com/permissions and try `/api/google-auth` again. Google only gives a refresh token on first consent.

**Still shows 3x daily sync delay** → Clear browser cache, hard reload War Room. Check that /api/calendar returns 200 and not 412.

---

## How it works

1. **Refresh token** is stored once in Neon when you do the OAuth flow
2. When you tap Sync, War Room calls `/api/calendar` on Vercel
3. The API swaps refresh_token → access_token (1-second request to Google)
4. It fetches events from all 3 calendars (Primary + TWEG + Partiful) in parallel
5. Returns events grouped by date
6. Your browser updates localStorage cache and re-renders — no page reload

The scheduled 3x daily task is still running as a backup. If the OAuth setup ever breaks, that keeps the HTML seed up to date.
