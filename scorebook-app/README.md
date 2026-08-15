# Scorebook

A private live softball scorekeeping and season-stats app. Vite + React on the
frontend, Supabase (Postgres) for storage, deployed on Vercel.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New project. Pick any name/region, set a database password (you won't need it day-to-day).
2. Once it's created, open **SQL Editor → New query**, paste in the contents of `supabase/schema.sql`, and run it. This creates the `teams`, `players`, and `games` tables and turns on Realtime for `games`.
3. Go to **Project Settings → API**. You'll need two values from here in a minute:
   - **Project URL**
   - **anon public** key

## 2. Run it locally (optional but recommended first)

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste in your Project URL + anon key
npm run dev
```

Open the local URL it prints. Turn on **Scorekeeper Mode** in the top bar, add a team, add players, and start a game to make sure it's all wired up before you deploy.

## 3. Push to GitHub

```bash
git init
git add .
git commit -m "Scorebook"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/scorebook.git
git push -u origin main
```

(No GitHub account handy? You can also deploy straight from your machine with `npx vercel` instead of steps 3–4 — see the note at the bottom.)

## 4. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo. Vercel will auto-detect it as a Vite app — no config needed.
2. Before the first deploy (or right after, then redeploy), add these under **Project → Settings → Environment Variables**:
   - `VITE_SUPABASE_URL` — your Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY` — your Supabase anon public key
   - `ANTHROPIC_API_KEY` — your Anthropic API key, only if you want the "Generate Recap" button to work (see below). Get one at [console.anthropic.com](https://console.anthropic.com).
   - `VITE_APP_PASSCODE` — optional, see "Privacy notes" below.
3. Deploy. You'll get a URL like `https://scorebook-yourname.vercel.app` — that's the link you send to family.

### Deploying without GitHub

From inside the project folder:
```bash
npm install -g vercel
vercel        # first deploy, follow the prompts
vercel --prod # promote to your production URL
```
Then add the same environment variables in the Vercel dashboard and run `vercel --prod` again so the build picks them up.

## Recap generation

The "Generate Recap" button calls `/api/recap`, a small serverless function (in `api/recap.js`) that calls the Anthropic API using `ANTHROPIC_API_KEY` from Vercel's environment variables. This has to happen server-side — an API key can't safely live in code that runs in the browser. If you skip setting `ANTHROPIC_API_KEY`, the button will still work but leave the recap box empty for you to type into by hand.

## Privacy notes

This app has no login system — anyone who has your Vercel URL can open it, and if `VITE_APP_PASSCODE` isn't set, anyone in Viewer Mode can also just tap into Scorekeeper Mode. That matches how the original share-link version worked: privacy comes from the link being unlisted, not from access control. A few things are already in place to help:

- `robots.txt` and an `X-Robots-Tag: noindex` header keep the app out of Google and other search engines.
- Setting `VITE_APP_PASSCODE` in Vercel adds a simple lock screen — anyone with the link also needs the passcode. It's stored in plain text in an environment variable and checked in the browser, so treat it as a deterrent, not real security (don't reuse a password you care about).

If you want actual access control — e.g., only specific email addresses can view or edit — that's a bigger step up: Supabase Auth (magic-link email sign-in) plus rewriting the RLS policies in `schema.sql` to check `auth.uid()` instead of allowing everyone. Worth doing if the team roster ever includes anything more sensitive than names and stats, but it's more setup than most family use cases need.

## Project structure

```
src/App.jsx           the whole app UI + Supabase calls
src/lib/supabaseClient.js
api/recap.js           serverless function for the AI recap
supabase/schema.sql     run this once in Supabase's SQL editor
vercel.json             noindex header + SPA routing
```
