# War Room Cloud

Cross-device synced version of War Room. Deployed to Vercel, backed by Neon Postgres.

## Architecture

```
[iPhone Safari / Mac Chrome]
       |
       v
  Vercel (static HTML + API routes)
       |
       v
  Neon Postgres (user_state table, JSONB values)
```

The existing War Room code is untouched. `sync-client.js` hijacks `localStorage` so writes go to both local (fast) and Neon (persistent). On page load, cloud state is merged into localStorage before the app renders.

---

## Deploy Checklist

### 1. Create Neon database (5 min)

1. Go to https://neon.tech and sign up (free tier)
2. Create a new project — name it `warroom`
3. From the dashboard, grab the **connection string** (starts with `postgresql://...`)
4. Open the Neon SQL editor and paste the contents of `schema.sql`, then Run

### 2. Create GitHub repo (3 min)

```bash
cd ~/Documents/Claude/Projects/Personal/warroom-cloud
git init
git add .
git commit -m "Initial War Room cloud version"

# Create repo on GitHub (via gh CLI or web UI), then:
git remote add origin https://github.com/YOUR_USERNAME/warroom-cloud.git
git branch -M main
git push -u origin main
```

### 3. Deploy to Vercel (5 min)

1. Go to https://vercel.com/new
2. Import the `warroom-cloud` GitHub repo
3. Framework Preset: **Other**
4. Leave build/output settings default
5. Add Environment Variables:
   - `DATABASE_URL` = (Neon connection string from step 1)
   - `AUTH_PASSWORD` = (pick a password you'll remember)
   - `SESSION_SECRET` = (any random 32+ char string — run `openssl rand -hex 32` in terminal)
6. Click **Deploy**

Once deployed, Vercel gives you a URL like `warroom-cloud.vercel.app`. Visit it.

### 4. Migrate existing data (one-time, 2 min)

You have task/goal/calendar data in your current localhost War Room. To move it to the cloud:

**On your Mac, visit http://localhost:8742/daily-planner.html**, open DevTools console (Cmd+Opt+J), and run:

```js
copy(JSON.stringify(Object.fromEntries(Object.entries(localStorage))))
```

This copies all your War Room data to the clipboard.

**Now visit your new Vercel URL, log in, open DevTools console, and run:**

```js
const data = PASTE_YOUR_CLIPBOARD_HERE;
for (const [k,v] of Object.entries(data)) localStorage.setItem(k, v);
await window.warroomForceSync();
location.reload();
```

(Replace `PASTE_YOUR_CLIPBOARD_HERE` with the pasted JSON.)

Your tasks, goals, outcomes, and calendar cache are now synced to Neon.

---

## Custom domain (optional)

In the Vercel project settings → Domains, add `warroom.ezrklabs.com` or whatever subdomain you own. Update DNS to point to Vercel (they give you the exact record to add).

---

## Daily use

- Visit `warroom.vercel.app` (or your custom domain) on any device
- Sign in once with your password — cookie lasts 30 days
- Add to Home Screen on iPhone for PWA-like feel
- Data syncs automatically across all signed-in devices within a second

**Sync indicator** appears briefly in the bottom-right corner:
- Green SYNCED = saved to cloud
- Red SYNC ERR = offline, will retry
- Grey OFFLINE = couldn't reach server at boot

**Manual controls** (DevTools console):
- `warroomForceSync()` — flush pending changes immediately
- `warroomLogout()` — sign out

---

## Known limitations

- **No conflict resolution yet.** If you edit a task on your phone and Mac in the same second, last-write-wins. Probably fine for one user but worth knowing.
- **Requires internet.** Offline use works (localStorage still persists) but changes don't sync until back online.
- **Single user only.** Sharing with others would need real auth.

---

## File structure

```
warroom-cloud/
├── api/
│   ├── _auth.js       # signed cookie helper
│   ├── login.js       # POST password → session cookie
│   ├── logout.js      # clear cookie
│   ├── me.js          # session check
│   ├── load.js        # GET all cloud state
│   └── sync.js        # POST updates → Neon
├── public/
│   ├── daily-planner.html   # main app (unchanged except sync-client)
│   ├── weekly-goals.html    # goals app
│   ├── login.html           # password entry
│   ├── sync-client.js       # localStorage hijacker
│   └── *.png                # PWA icons
├── schema.sql         # run once in Neon SQL editor
├── vercel.json        # routing + cache headers
├── package.json
└── .gitignore
```

## Troubleshooting

- **401 errors in console:** cookie expired or missing. Visit `/login.html` again.
- **"Server not configured":** env vars missing in Vercel. Check Settings → Environment Variables.
- **Data not syncing:** check DevTools Network tab for `/api/sync` requests. If they're failing, check Neon's connection limits (free tier caps at 100 concurrent connections — shouldn't be an issue for one user).
