# Improv Cards

A mobile-first flashcard app for improv knowledge (archetypes, roles, situations, genres, voices,
locations, pop culture), with spaced repetition and an AI connector (MCP) so you can create and
extend cards by talking to Claude or another assistant. See `PLAN.md` for the design and
`card-types.md` for the card templates.

Runs entirely on Cloudflare's free tier: one Worker serves the app, the API and the MCP server;
the data lives in a D1 (SQLite) database.

## Deploy (one time, ~10 minutes)

You need a free Cloudflare account.

1. Install dependencies and log in to Cloudflare:
   ```bash
   npm install
   ```
   ```bash
   npx wrangler login
   ```
2. Create the database and copy the printed `database_id` into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create improv-db
   ```
3. Set the four secrets. Each command asks for a value. Use your own password for
   `APP_PASSWORD`, and long random strings for the other three. This prints a random string:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   ```bash
   npx wrangler secret put APP_PASSWORD
   ```
   ```bash
   npx wrangler secret put SESSION_SECRET
   ```
   ```bash
   npx wrangler secret put MCP_SECRET
   ```
   ```bash
   npx wrangler secret put API_TOKEN
   ```
   The first time, Wrangler says there's no Worker called "improv-flashcards" yet and asks
   whether to create it: answer **yes**. It creates an empty Worker to hold the secrets, and
   step 4 deploys the app into it.

   Keep `MCP_SECRET` and `API_TOKEN` somewhere safe: they're the keys for AI access.
4. Build, create the tables and deploy:
   ```bash
   npm run deploy
   ```
   Wrangler prints your URL, e.g. `https://improv-flashcards.<your-subdomain>.workers.dev`.

To deploy a new version later, run `npm run deploy` again.

## Use it on your phone

Open the URL, log in with `APP_PASSWORD` (remembered for a year), then use the browser's
**Add to Home Screen** so it opens full-screen like an app.

## Connect Claude

1. On claude.ai: **Settings → Connectors → Add custom connector**.
2. URL: `https://improv-flashcards.<your-subdomain>.workers.dev/mcp/<MCP_SECRET>`
3. In a chat (also in the Claude phone app), enable the connector from the tools menu and talk:
   *"Make a card for a pirate captain"*, *"Add to the doctor card that they check their pager"*,
   *"Fill in the stubs"*.

Everything the AI changes shows up in **Browse → AI changes to review** (red dot on the tab).

### Other AI assistants

- Any assistant that supports remote MCP servers can use the same URL.
- For assistants that use REST "actions" (e.g. custom GPTs), import
  `https://…/api/openapi.json` and authenticate with `Authorization: Bearer <API_TOKEN>`.
- The instructions the AI gets are in `src/worker/ai/guidance.md`; the tools are in
  `src/worker/ai/tools.ts`.

## Local development

```bash
npm install
```
Create `.dev.vars` (copy `.dev.vars.example`), then create the local database:
```bash
npm run db:migrate:local
```
```bash
npm run dev
```
Open http://localhost:5173 (the app, with live reload; API calls go to the Worker on port 8787).
The local MCP endpoint is `http://localhost:8787/mcp/<MCP_SECRET from .dev.vars>`.

## Changing card templates

Edit `src/shared/templates.ts`. Existing cards adapt automatically: new questions show up
empty, and answers under removed questions are kept as extra questions on those cards.

## Project layout

- `src/shared/`: card templates, types, link parsing and diffing (used by both sides)
- `src/worker/core/`: card service (all reads and writes, revisions, undo, AI inbox) and scheduling (FSRS)
- `src/worker/ai/`: MCP server, tool definitions, OpenAPI spec, AI guidance
- `src/app/`: the Preact phone app
- `migrations/`: D1 database schema
