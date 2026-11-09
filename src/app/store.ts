import { computed, signal } from "@preact/signals";
import { linkedSlugs, normalizeText } from "../shared/cards";
import type { Card, Settings } from "../shared/types";
import { api } from "./api";

export const cards = signal<Card[]>([]);
export const settings = signal<Settings | null>(null);
export const inboxCount = signal(0);
export const loaded = signal(false);
/** Increments whenever cards change; screens that cache derived data can depend on it. */
export const dataVersion = signal(0);

export const cardsById = computed(() => new Map(cards.value.map((c) => [c.id, c])));
export const cardsBySlug = computed(() => new Map(cards.value.map((c) => [c.slug, c])));

export const backlinkIndex = computed(() => {
  const index = new Map<string, Card[]>();
  for (const c of cards.value)
    for (const slug of linkedSlugs(c)) index.set(slug, [...(index.get(slug) ?? []), c]);
  return index;
});

export function titleOf(slug: string): string | undefined {
  return cardsBySlug.value.get(slug)?.title;
}

let inflight: Promise<void> | null = null;

export function refresh(): Promise<void> {
  inflight ??= api<{ cards: Card[]; settings: Settings; inboxCount: number }>("/api/bootstrap")
    .then((data) => {
      cards.value = data.cards.sort((a, b) => a.title.localeCompare(b.title));
      settings.value = data.settings;
      inboxCount.value = data.inboxCount;
      loaded.value = true;
      dataVersion.value++;
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** Put a freshly saved card into the cache without a full reload. */
export function upsertCard(card: Card) {
  const rest = cards.value.filter((c) => c.id !== card.id);
  cards.value = [...rest, card].sort((a, b) => a.title.localeCompare(b.title));
  dataVersion.value++;
}

export interface Suggestion {
  card: Card;
  /** How the match was made, for ranking/debugging. */
  score: number;
}

/** Cards whose title/alias matches `query`, ranked; cards of `preferType` first. */
export function suggestCards(query: string, preferType?: string, limit = 6, excludeId?: string): Suggestion[] {
  const q = normalizeText(query);
  if (!q)
    return preferType
      ? cards.value
          .filter((c) => c.type === preferType && c.id !== excludeId)
          .slice(0, limit)
          .map((card) => ({ card, score: 1 }))
      : [];
  const out: Suggestion[] = [];
  for (const card of cards.value) {
    if (card.id === excludeId) continue;
    const names = [card.title, ...card.aliases].map(normalizeText);
    let score = 0;
    for (const n of names) {
      if (n === q) score = Math.max(score, 100);
      else if (n.startsWith(q)) score = Math.max(score, 60);
      else if (n.split(" ").some((w) => w.startsWith(q))) score = Math.max(score, 40);
      else if (q.length >= 3 && n.includes(q)) score = Math.max(score, 20);
    }
    if (!score) continue;
    if (preferType && card.type === preferType) score += 25;
    if (!card.isStub) score += 5;
    out.push({ card, score });
  }
  return out.sort((a, b) => b.score - a.score || a.card.title.localeCompare(b.card.title)).slice(0, limit);
}
