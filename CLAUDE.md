# Grok Mail - working notes for Claude / Codex

Owner: Suman Dhungel. He does not write code; explain changes in plain words.

## What this is
Vue 3 + Vite mail client with a Nitro server (src/server), Neon Postgres, deployed on Vercel
(project `grok-mail`, https://grok-mail-bay.vercel.app). Mail for suman@mail.grokbot.com arrives via
Grok Bot routines calling /api/ingest; sends go to an outbox that Grok Bot delivers after Suman approves.

## Current goal: UI redesign
- Change only presentation (components, styles, layout). Do NOT change API routes, server code,
  auth, ingest, outbox, or data shapes unless Suman explicitly asks.
- Target look: clean, dense, modern (Gmail / Superhuman feel), light + dark mode, clear unread state,
  good spacing and type scale, mobile-friendly (it is used as an iPhone home-screen app).
- Work in small steps; after each step run `npm run build` and fix errors.

## Commands
- `npm install` then `npm run dev` for a local preview (shows sample mail; no secrets needed).
- `npm run build` must pass before committing.

## Rules
- Never commit secrets or .env files. Env vars live in Vercel only.
- Keep the security fixes already in scripts/grok-pwa-shared.mjs, src/lib/env.server.ts and
  src/server/mail/config.server.ts (extensions opt-in, https-only webhook, 32+ char session secret).
- Commit to a branch and open a PR; pushing to `main` deploys to production once Vercel Git is connected.

Also read AGENTS.md for the original project guide.

