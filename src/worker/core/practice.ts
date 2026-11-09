import { createEmptyCard, fsrs, type Card as FsrsCard, type Grade } from "ts-fsrs";
import { practiceSections } from "../../shared/cards";
import { DEFAULT_SETTINGS, type Card, type PracticeItem, type PracticeQueue, type Settings, type SrsState } from "../../shared/types";
import { UserError } from "./service";

const scheduler = fsrs({ enable_fuzz: true });
const DAY = 86_400_000;

export function toSrsState(c: FsrsCard): SrsState {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.toISOString() : null,
  };
}

export function fromSrsState(s: SrsState): FsrsCard {
  return {
    ...s,
    due: new Date(s.due),
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  };
}

/** UTC timestamp of local midnight, given the client's Date#getTimezoneOffset() in minutes. */
function startOfLocalDay(nowMs: number, tzOffsetMin: number) {
  const shift = tzOffsetMin * 60_000;
  return Math.floor((nowMs - shift) / DAY) * DAY + shift;
}

export async function getSettings(db: D1Database, ownerId: string): Promise<Settings> {
  const row = await db.prepare("SELECT data FROM settings WHERE owner_id = ?").bind(ownerId).first<{ data: string }>();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.data) : {}) };
}

export async function saveSettings(db: D1Database, ownerId: string, patch: Partial<Settings>) {
  const settings = { ...(await getSettings(db, ownerId)), ...patch };
  await db
    .prepare("INSERT INTO settings (owner_id, data) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data")
    .bind(ownerId, JSON.stringify(settings))
    .run();
  return settings;
}

export async function buildQueue(
  db: D1Database,
  ownerId: string,
  cards: Card[],
  opts: { tzOffset: number; types?: string[]; tags?: string[] },
): Promise<PracticeQueue> {
  const settings = await getSettings(db, ownerId);
  const nowMs = Date.now();
  const dayStart = startOfLocalDay(nowMs, opts.tzOffset);
  const dayEnd = new Date(dayStart + DAY).toISOString();

  const counts = await db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(was_new), 0) AS new FROM review_log WHERE owner_id = ? AND reviewed_at >= ?",
    )
    .bind(ownerId, new Date(dayStart).toISOString())
    .first<{ total: number; new: number }>();
  const reviewedToday = counts?.total ?? 0;
  const newToday = counts?.new ?? 0;

  const { results } = await db
    .prepare("SELECT card_id, section_key, state FROM srs WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ card_id: string; section_key: string; state: string }>();
  const srs = new Map(results.map((r) => [`${r.card_id}/${r.section_key}`, JSON.parse(r.state) as SrsState]));

  const due: PracticeItem[] = [];
  const fresh: PracticeItem[] = [];
  const eligible = cards
    .filter((c) => !c.isStub)
    .filter((c) => !opts.types?.length || opts.types.includes(c.type))
    .filter((c) => !opts.tags?.length || c.tags.some((t) => opts.tags!.includes(t)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const card of eligible) {
    for (const section of practiceSections(card)) {
      const state = srs.get(`${card.id}/${section.key}`);
      if (!state) fresh.push({ cardId: card.id, sectionKey: section.key, isNew: true, srs: null });
      else if (state.due < dayEnd) due.push({ cardId: card.id, sectionKey: section.key, isNew: false, srs: state });
    }
  }
  due.sort((a, b) => a.srs!.due.localeCompare(b.srs!.due));
  const reviewBudget = Math.max(0, settings.maxReviewsPerDay - (reviewedToday - newToday));
  const newBudget = Math.max(0, settings.newPerDay - newToday);
  const dueItems = due.slice(0, reviewBudget);
  // Spread new sections out so two questions of the same card don't come right after each other.
  const newItems = spreadByCard(fresh).slice(0, newBudget);
  return {
    items: interleave(dueItems, newItems),
    dueCount: dueItems.length,
    newCount: newItems.length,
    reviewedToday,
  };
}

function spreadByCard(items: PracticeItem[]): PracticeItem[] {
  const byCard = new Map<string, PracticeItem[]>();
  for (const i of items) byCard.set(i.cardId, [...(byCard.get(i.cardId) ?? []), i]);
  const out: PracticeItem[] = [];
  const groups = [...byCard.values()];
  for (let round = 0; out.length < items.length; round++)
    for (const g of groups) if (g[round]) out.push(g[round]);
  return out;
}

/** One new item after every few reviews, so a session isn't all-new at the end. */
function interleave(due: PracticeItem[], fresh: PracticeItem[]): PracticeItem[] {
  if (!fresh.length) return due;
  if (!due.length) return fresh;
  const every = Math.max(1, Math.round(due.length / fresh.length));
  const out: PracticeItem[] = [];
  let f = 0;
  due.forEach((d, i) => {
    out.push(d);
    if ((i + 1) % every === 0 && f < fresh.length) out.push(fresh[f++]);
  });
  return out.concat(fresh.slice(f));
}

export async function recordReview(
  db: D1Database,
  ownerId: string,
  input: { cardId: string; sectionKey: string; rating: number; reviewedAt?: string; mode?: string },
) {
  if (![1, 2, 3, 4].includes(input.rating)) throw new UserError("rating must be 1 (again) to 4 (easy)");
  const when = input.reviewedAt ? new Date(input.reviewedAt) : new Date();
  const row = await db
    .prepare("SELECT state, created_at FROM srs WHERE card_id = ? AND section_key = ? AND owner_id = ?")
    .bind(input.cardId, input.sectionKey, ownerId)
    .first<{ state: string; created_at: string }>();
  const current = row ? fromSrsState(JSON.parse(row.state)) : createEmptyCard(when);
  const next = scheduler.next(current, when, input.rating as Grade).card;
  const state = toSrsState(next);
  const t = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO srs (owner_id, card_id, section_key, due, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(card_id, section_key) DO UPDATE SET due = excluded.due, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(ownerId, input.cardId, input.sectionKey, state.due, JSON.stringify(state), t, t),
    db
      .prepare(
        "INSERT INTO review_log (owner_id, card_id, section_key, rating, was_new, mode, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(ownerId, input.cardId, input.sectionKey, input.rating, row ? 0 : 1, input.mode ?? "single", when.toISOString()),
  ]);
  return { srs: state };
}

export async function stats(db: D1Database, ownerId: string, tzOffset: number) {
  const since = new Date(startOfLocalDay(Date.now(), tzOffset) - 29 * DAY).toISOString();
  const { results } = await db
    .prepare("SELECT reviewed_at FROM review_log WHERE owner_id = ? AND reviewed_at >= ?")
    .bind(ownerId, since)
    .all<{ reviewed_at: string }>();
  const perDay = new Map<string, number>();
  for (const r of results) {
    const local = new Date(new Date(r.reviewed_at).getTime() - tzOffset * 60_000).toISOString().slice(0, 10);
    perDay.set(local, (perDay.get(local) ?? 0) + 1);
  }
  let streak = 0;
  const today = startOfLocalDay(Date.now(), tzOffset);
  for (let d = 0; d < 30; d++) {
    const localKey = new Date(today - d * DAY - tzOffset * 60_000).toISOString().slice(0, 10);
    if (perDay.get(localKey)) streak++;
    else if (d > 0) break;
  }
  return { streak, perDay: Object.fromEntries(perDay) };
}
