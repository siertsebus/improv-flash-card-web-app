# Improv Flashcards — Application Plan (v2, for review)

## 1. What we're building

A personal, mobile-first web app for memorising the *expected* associations that make improv scenes land (archetypes, roles, situations, genres, pop culture, voices, locations), with:

1. **Practice** — quick spaced-repetition sessions on the phone, with several modes to try out. Works offline on the train.
2. **Knowledge base** — cards link to each other (wedding → church, priest), with backlinks, so you can browse it like a mini wiki.
3. **Authoring through an AI assistant** — you don't type cards on your phone. You talk to Claude (voice in the Claude app) and it creates/extends cards. The connection uses open standards so another AI service can be plugged in later.

Card types and their default questions come from `card-types.md`. All content is in English.

---

## 2. Architecture

```
 ┌──────────────┐        ┌───────────────────────────────────────────────┐
 │ Phone browser│  HTTPS │  Cloudflare Worker (one deployment)           │
 │ (PWA, offline│◄──────►│   /             → static app (PWA)            │
 │  cache)      │        │   /api/*        → REST API (+ OpenAPI spec)   │
 └──────────────┘        │   /mcp/<secret> → MCP server                  │
 ┌──────────────┐        │          │              │                     │
 │ Claude / any │  MCP or│          └──► core service layer ◄──┘         │
 │ AI assistant │  REST  │                (all card logic)               │
 └──────────────┘        │                       ▼                       │
                         │             Cloudflare D1 (SQLite)            │
                         └───────────────────────────────────────────────┘
```

**One codebase, one deploy, one database.**

### Staying AI-vendor independent
- All card logic (search, create, add items, linking, revisions) lives in **one core service layer**. MCP and the REST API are thin adapters on top of it — no Claude-specific code anywhere in the core.
- **MCP is an open standard**, not Claude-only: ChatGPT, Gemini, Mistral Le Chat, Cursor and others support remote MCP servers to varying degrees. So the same connector URL should work elsewhere.
- For assistants that don't speak MCP, the **REST API publishes an OpenAPI spec** (e.g. usable as ChatGPT "Custom GPT Actions" or any tool-calling framework).
- The guidance for the AI ("search before creating, follow the templates…") is a plain text/Markdown file in the repo, shared by both adapters — easy to edit or reuse.
- The server never calls an AI itself, so there's no API key or AI cost on the server side.

### Hosting & database: Cloudflare (free tier)

| Piece | Service | Free tier (more than enough for text cards) |
|---|---|---|
| App + API + MCP server | Cloudflare Workers (static assets included) | 100k requests/day |
| Database | Cloudflare D1 (SQLite) | 5 GB storage, millions of reads/day |
| Login for the web app | Cloudflare Access (email one-time code) | free up to 50 users |
| Nightly backup | Cron Trigger → JSON export | free |

Why: €0, never "sleeps" (unlike Supabase free tier, which pauses after a week of inactivity), first-class remote-MCP support, and SQLite fits a tiny relational dataset perfectly.

Alternatives considered: GitHub repo as database (nice history, but every review would be a commit — bad fit for SRS state); Supabase / Turso / Firebase (work, but second vendor and/or pausing).

### Tech stack
- **TypeScript** throughout.
- **Frontend:** Vite + Preact + `vite-plugin-pwa` (install to home screen, offline cache).
- **Backend:** Hono on Workers + D1 via Drizzle ORM.
- **MCP:** official MCP TypeScript SDK (Streamable HTTP transport).
- **Spaced repetition:** FSRS (`ts-fsrs`, the algorithm modern Anki uses).

---

## 3. Data model — flexible by design

Guiding principle: **templates are the default, never a cage.** Nothing you add to a card can ever make it "invalid", unlinkable, or lose its type.

### Card types = templates
Each type defines its **default questions** (stable `key` + prompt text + an optional *hint* of what kind of card its answers usually link to):

```ts
situation: {
  label: "Situation",
  questions: [
    { key: "happens", prompt: "What typically happens?" },
    { key: "where",   prompt: "Where do these situations occur?", linkHint: "location" },
    { key: "people",  prompt: "What types of people are present?", linkHint: "archetype" },
  ]
}
```
Types: `archetype`, `role`, `situation`, `genre`, `popculture`, `voice`, `location`.

- `linkHint` is only a suggestion. **Any item can link to any card of any type.**
- Templates live in a config file in the repo. Changing a template (e.g. adding a question to all archetypes) is a deliberate edit — something you'd ask for explicitly.

### Card
```
Card
  id, owner_id, slug ("wedding"), type ("situation"), title ("Wedding")
  aliases     ["marriage ceremony"]      ← helps search & the AI find it
  summary     optional one-liner
  tags        optional ["western-show", "favourite"]
  sections    ordered list of Section
  references  optional list of Reference (shown after reveal, never quizzed)
  notes       optional free text (not quizzed)

Section                         ← one "question" on the card
  key, prompt
  origin      "template" | "custom"
  status      "open" | "not_applicable"
  items       [Item]

Item
  id, text ("Family members give speeches at the [[church]]")
              ← links are written inline, wiki-style: [[slug]] or [[slug|shown text]],
                so one answer can contain several links
  references? Reference(s) attached to just this item

Reference
  label ("Irish accent — example"), url (YouTube, article, image…)
```

How this solves the rigidity problems you described:
- **Extra question on one card:** add a `custom` section to that card only. It stays an archetype, stays linkable, and is quizzed like any other section. The template is untouched.
- **"I don't know where to put this":** every card has `notes` (not quizzed) and the option of a custom section. Nothing is ever blocked.
- **Questions with no answer:** a section can be empty for two reasons, and the app keeps them apart:
  - *Not filled in yet* — skipped in practice, but listed under "to fill" so you or the AI can complete it later.
  - *Not applicable* — e.g. *Irredeemable villain → How does their personality change?* Marked once (by you or the AI), then hidden from practice and shown collapsed on the card. If "it doesn't change" is itself worth remembering, you can just write it as the answer instead.
- **Template changes later:** cards missing a newly added template question simply show it as empty; removed template questions become `custom` sections on cards that had content. No data is lost.
- **Reference material (videos, images, articles):** attach `references` to a card or to a single item. They appear only after you reveal the answer — e.g. *Irish accent* → link to a video of someone speaking it.

### Links & knowledge base
- Links stored in a `links` table → cheap **backlinks** ("Church is referenced by: Wedding, Funeral, Vampire genre").
- Linking to a card that doesn't exist yet creates a **stub** (like a red Wikipedia link). Stubs appear in a "to write" list.
- Renaming/merging a card updates all links automatically.

### History & undo
Every change writes a **revision** (source: `app` / `ai`, before/after). A "recent changes" feed with **undo** per change makes misheard voice commands harmless.

### AI review inbox
Every AI edit starts out **unreviewed**.
- The **Browse** tab shows a notification dot with a count when there are unreviewed AI changes.
- At the top of Browse, an **"AI changes to review"** list shows one row per affected card: *New card* or *Edited*, with a short summary like "+3 answers in *What typically happens?*".
- Tapping a row opens the card with the AI's changes **highlighted** (added answers marked, removed ones struck through).
- From there you can: **✓ Looks good** (marks it reviewed), **edit** it by hand (saving marks it reviewed too), or **undo** the AI's change.
- The dot disappears when the list is empty. A "mark all reviewed" button covers the case where you trust a big batch.

### Review state
The SRS unit is one **(card, section)** pair — e.g. "Wedding — What typically happens?". Only sections with at least one item that aren't marked *not applicable* are quizzed. All practice modes below update these same records, so you can switch modes freely without messing up scheduling.

### Ready for multiple users later (not built now)
Every row has an `owner_id` from day one, and all queries are scoped by it. That keeps a future "share / fork someone's deck into your own library" feature possible without a database migration. Phase 1 has exactly one user: you.

---

## 4. Practice

### Grading
Classic buttons after reveal: **Again · Hard · Good · Easy** (FSRS standard). Large buttons at the bottom of the screen.

### Practice modes (switchable in settings or at session start, so you can find what works)

**A. Single question** (one section at a time)
> **Wedding** · Situation — *What typically happens?*
> → Reveal → answer list → grade.

Each section of a card comes up as its own flashcard, at its own time.

**B. Card with one section hidden** (Anki-style "cloze" with context)
> The whole Wedding card is shown, with *Where does it occur?* and *Who is present?* visible as context, and *What typically happens?* blacked out.
> → Reveal the hidden one → grade that section.

Same scheduling as A, but the other sections act as memory cues.

**C. Whole card hidden** (all sections blacked out)
> **Wedding** · Situation, with three hidden sections.
> → Recall everything, then reveal and grade section by section (or reveal all and grade each).

Good for building the complete mental picture of a topic. A card comes up in this mode when *any* of its sections is due; sections that aren't due are graded optionally.

Later modes (phase 3):
- **Reverse** — shown a few clues ("stethoscope, 'I need 10cc stat!', brisk walk") → guess the card. Trains recognition, i.e. what you need when a scene partner initiates.
- **Quick-fire drill** — random card + section, 20-second timer, no grading. A warm-up before a show.

### Session options
- **Due today** (default) with a configurable **daily new-sections limit** (start at 10, change it in settings once you know what feels right) and an optional daily review cap.
- **Filter** by card type or tag (e.g. only Genres, or only `western-show`).
- References and links on the answer side are tappable; they open in a full-screen "peek" with a clear back button and never lose your place.

### Mobile-first rules (things we deliberately avoid)
- No typing needed to practise; it's all tapping.
- Primary buttons in the bottom third, ≥ 48px tall. No hover-only UI, no drag-and-drop, no tiny icons.
- Swipes only as optional shortcuts (they fight with the browser's back-swipe).
- `dvh` units and safe-area insets so iOS/Android browser bars don't cover buttons.
- No modals with nested scrolling.
- **Installable PWA** — Add to Home Screen, opens full-screen like a native app.
- **Offline** — all cards cached on the phone; reviews done in a tunnel are queued and synced later.
- Dark mode follows the system.

### Navigation
A bottom tab bar (thumb reach): **Practice · Browse · Changes · Settings**. Practice and Browse remember where you were when you switch between them.

### Browse & search (outside practice)
- Search bar pinned at the top; results update as you type and match titles, aliases, tags *and* answer text ("stethoscope" finds Doctor).
- Filter chips per card type and tag; a "recently viewed" list when the search is empty.
- Tapping a result opens the **card page in read mode**: all sections and answers, links, backlinks ("referenced by"), references, notes. Links jump to other cards; the back button walks back through what you browsed.
- Pencil button on the card page → edit mode (see below).
- Also reachable from Browse: **Stubs** (referenced-but-unwritten cards) and **To fill** (cards with unfilled sections).

### Other screens
- **Changes** — full history of edits (yours and the AI's) with undo. (Unreviewed AI edits also appear in the inbox in Browse.)
- **Stats** (light, inside Settings) — streak, reviews per day, cards per type.

### Quick edit while practising
- Pencil button on the practice screen (before and after reveal).
- Opens the card's editor as a full-screen sheet on top of the session. Save or close → you're back on the **exact same card in the same state** (still revealed, not yet graded), with your edit already visible.
- The session queue and scheduling are untouched; editing never counts as a grade.

### Editing in the app — full parity with the AI
Two fully featured ways to edit, for different situations: **ramble to the AI** when you have a lot to add, **edit by hand** for a quick fix. Both call the same core service layer, so every operation the AI has (section 5) also has a button in the app, and every app edit shows up in the change history with undo.

Kept phone-friendly:
- **Edit mode per card** (pencil button) instead of always-editable text, so you don't edit by accident while practising.
- Tap an item to edit its text inline; an "add item" field at the bottom of each section; delete via a small menu with undo, not a confirm dialog.
- Reordering with ↑/↓ buttons, no drag-and-drop.
- **New card:** pick a type → the template's questions appear as empty sections → fill in what you know, leave the rest open.
- Also in the app: notes, tags, aliases, references, mark section *not applicable*, add custom section, rename / merge / change type.
- If the AI and the app edit the same card at roughly the same time, the later save is checked against the card version so nothing is silently overwritten.

### Easy linking (autocomplete)
Linking should take one tap, not a separate dialog.

1. **Live suggestions while typing.** As you type an answer, a row of suggestion chips appears **directly above the input** (not below — on phones the keyboard would cover a dropdown). It shows cards whose title or alias matches the word(s) you're typing: typing "chu…" shows `Church`. Tap a chip → that word becomes a link.
2. **Smart ranking.** Suggestions use the question's link hint: under *Where does it occur?* locations rank first; under *Who is present?* archetypes rank first. Exact title/alias matches beat partial ones.
3. **Not there yet? One tap to make a stub.** The last chip is always `+ New card "Church"` (type pre-picked from the hint), which creates a stub and links it.
4. **Auto-detected links after saving.** If a saved answer mentions an existing card's title or alias without a link ("A priest gives the sermon" while a `Priest` card exists), the word is shown with a dotted underline and a small "link?" chip — tap to confirm, or ignore it. Nothing is linked without your tap.
5. **Power-user shortcut.** Typing `[[` opens the same suggestion row for any card, for linking text that doesn't literally match a title ("the vicar" → `Priest`).
6. **Unlink / change link** via the item's small menu.

The AI uses the same matching on the server: when it writes an item naming a known card, it links it; otherwise it can create a stub.

---

## 5. AI integration (MCP connector, Claude first)

Setup: add the server URL once as a **custom connector** on claude.ai (Pro supports this). It's then available in the Claude mobile app, where you can dictate.

### Tools (same set via MCP and REST)
| Tool | Purpose |
|---|---|
| `get_card_types` | Templates + default questions, so the AI knows where things belong |
| `search_cards(query, type?, tag?)` | Find existing cards by title/alias/content (prevents duplicates) |
| `get_card(slug)` | Full card incl. sections, links, backlinks, references |
| `create_card(type, title, sections, aliases?, tags?, references?, notes?)` | New card from template; links resolved by title/alias, missing ones become stubs |
| `add_items(slug, sectionKey, items[])` | Append answers, skipping near-duplicates |
| `update_item` / `remove_item` / `move_item` | Fine-grained edits |
| `add_reference(slug, url, label, itemId?)` | Attach a video/article/image |
| `add_custom_section(slug, prompt)` | Extra question on one card — **only when you explicitly ask** |
| `set_notes(slug, text)` | Free-text catch-all |
| `set_section_status(slug, sectionKey, status)` | Mark a question *not applicable* (or reopen it) |
| `list_unfilled` | Cards with sections that haven't been filled in yet |
| `rename_card` / `merge_cards` / `change_type` | Keeps all links consistent |
| `list_stubs` | Referenced but unwritten cards |
| `recent_changes` / `undo_change` | Review or revert edits |

Changing the templates themselves stays a code/config change (you can ask Claude Code to do it), so a chatbot can't silently redesign your categories.

### AI guidance (shipped with the server, plain Markdown)
- Always search before creating; never create duplicates.
- **Follow the template questions.** Only add a custom section when the user explicitly asks for one. If something doesn't fit any section, put it in the closest one or in notes, and say where it went.
- Keep items short: one idea, a few words to one sentence.
- Link items to existing cards when they name something that has (or deserves) its own card.
- Cards describe what is *expected*, not subversions.
- After editing, briefly confirm what changed and where.

### Example flows
- *"I just saw a great pirate captain scene — make a card for it."* → searches "pirate", creates **Pirate Captain** (archetype) with all template sections filled, links voice → **Pirate voice** (stub), offers to fill the stub.
- *"Add to the doctor card that they always check their pager."* → `add_items("doctor", "items", ["Pager"])`.
- *"Add a link to this Irish accent video to the Irish voice card."* → `add_reference(...)`.
- *"For the cowboy card, add a question about what they eat."* → explicit request → `add_custom_section`.

### Securing it
- **Web app:** a simple password login (stored as a Cloudflare secret), remembered on the phone for a year. No extra dashboard setup needed; Cloudflare Access can be added in front later.
- **MCP/REST endpoint:** phase 1 uses a long secret in the URL (MCP) or as a bearer token (REST). Fine for non-sensitive data. Optional later: OAuth via Cloudflare's `workers-oauth-provider` (needed anyway if this ever becomes multi-user).

---

## 6. Build phases

**Phase 1 — Core (usable end to end)**
1. Project scaffold, D1 schema (with `owner_id`), template config.
2. Core service layer + MCP server + REST API: search/get/create/add_items/update/remove, references, custom sections, stubs, revisions + undo.
3. Deploy to Cloudflare; connect to Claude; seed ~20–30 starter cards by talking to Claude.
4. PWA: practice mode **A** with Again/Hard/Good/Easy + FSRS, browse/search, card page with links, backlinks and references.
5. Full in-app editing (all operations the AI has, including creating new cards), quick edit during practice, and linking autocomplete.
6. AI review inbox with notification dot, plus the changes history with undo.

**Phase 2 — Comfort + modes to try**
- Practice modes **B** and **C**, offline review queue, install prompt, settings (daily limits, default mode), stats, nightly JSON backup, OpenAPI spec.

**Phase 3 — Extras**
- Reverse mode, quick-fire drill, tag filters, OAuth, and (if wanted) multi-user + deck sharing/forking.

---

## 7. Decisions so far
- Claude Pro → custom connector is fine.
- English only.
- Again / Hard / Good / Easy grading.
- Daily amount: configurable; start at 10 new sections/day.
- References (videos etc.) shown only after reveal; tags optional.
- Templates are the default; custom sections only on explicit request; nothing ever becomes "invalid".
- Single user now; schema prepared for multi-user later.
- Empty or *not applicable* questions are skipped in practice.
- Full editing parity: everything the AI can do, the app can do (including creating cards).

## 8. Remaining open points (can be decided during building)
1. Should mode **C** grade every section, or allow a single grade for the whole card? (Plan: per section, with a "grade all the same" shortcut.)
2. Is a Location card a full citizen from the start? (Plan: yes — it costs nothing and situations/genres link to it.)
3. Do you want a GitHub repo for the code? (Recommended: yes; Cloudflare can auto-deploy from it.)
