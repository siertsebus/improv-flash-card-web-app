import { TEMPLATE_BY_KEY } from "./templates";
import type { Card, CardContent, Item, Reference, Section } from "./types";

export function newId(len = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function slugify(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "card"
  );
}

/** Lowercased, punctuation-free form used for matching titles and detecting duplicate items. */
export function normalizeText(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ---------- inline links ----------

export const LINK_RE = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

export interface LinkToken {
  target: string;
  label?: string;
  start: number;
  end: number;
}

export function parseLinks(text: string): LinkToken[] {
  const out: LinkToken[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    out.push({
      target: m[1].trim(),
      label: m[2]?.trim() || undefined,
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

export function formatLink(slug: string, label?: string): string {
  return label ? `[[${slug}|${label}]]` : `[[${slug}]]`;
}

/** Replace every link in `text` using `fn`; fn returns the replacement string. */
export function mapLinks(text: string, fn: (t: LinkToken) => string): string {
  let out = "";
  let last = 0;
  for (const t of parseLinks(text)) {
    out += text.slice(last, t.start) + fn(t);
    last = t.end;
  }
  return out + text.slice(last);
}

/** Text with links replaced by their label (or the raw target). */
export function plainText(text: string, titleOf?: (slug: string) => string | undefined): string {
  return mapLinks(text, (t) => t.label ?? titleOf?.(t.target) ?? t.target);
}

export function allTexts(content: CardContent): string[] {
  const texts: string[] = [];
  for (const s of content.sections) for (const i of s.items) texts.push(i.text);
  texts.push(content.notes, content.summary);
  return texts;
}

export function linkedSlugs(content: CardContent): Set<string> {
  const out = new Set<string>();
  for (const t of allTexts(content)) for (const l of parseLinks(t)) out.add(l.target);
  return out;
}

// ---------- templates / normalisation ----------

export function emptyContent(): CardContent {
  return { aliases: [], summary: "", tags: [], sections: [], references: [], notes: "" };
}

/**
 * Bring a card's sections in line with its type's template: template sections first (in template
 * order, created empty if missing, prompt refreshed), then custom sections. Former template
 * sections that are no longer in the template are kept as custom if they have content.
 */
export function normalizeSections(type: string, sections: Section[]): Section[] {
  const template = TEMPLATE_BY_KEY[type];
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const out: Section[] = [];
  const templateKeys = new Set<string>();
  for (const q of template?.questions ?? []) {
    templateKeys.add(q.key);
    const existing = byKey.get(q.key);
    out.push({
      key: q.key,
      prompt: q.prompt,
      origin: "template",
      status: existing?.status ?? "open",
      items: existing?.items ?? [],
    });
  }
  for (const s of sections) {
    if (templateKeys.has(s.key)) continue;
    if (s.origin === "template" && s.items.length === 0) continue;
    out.push({ ...s, origin: "custom", status: s.status ?? "open" });
  }
  return out;
}

export function normalizeContent(type: string, content: Partial<CardContent>): CardContent {
  const base = emptyContent();
  const c = { ...base, ...content };
  return {
    aliases: uniqueStrings(c.aliases ?? []),
    summary: (c.summary ?? "").trim(),
    tags: uniqueStrings((c.tags ?? []).map((t) => slugify(t))),
    sections: normalizeSections(
      type,
      (c.sections ?? []).map((s) => ({
        ...s,
        status: s.status ?? "open",
        origin: s.origin ?? "custom",
        items: (s.items ?? [])
          .map((i) => (i.refs ? { ...i, refs: cleanRefs(i.refs) } : i))
          .filter((i) => i.text.trim() !== "" || (i.refs?.length ?? 0) > 0),
      })),
    ),
    references: cleanRefs(c.references ?? []),
    notes: (c.notes ?? "").trim(),
  };
}

function cleanRefs(refs: Reference[]): Reference[] {
  return refs
    .filter((r) => r.url?.trim())
    .map((r) => ({ ...r, url: r.url.trim(), label: r.label?.trim() || r.url.trim() }));
}

function uniqueStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const s = raw.trim();
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function hasContent(content: CardContent): boolean {
  return (
    content.sections.some((s) => s.items.length > 0) ||
    content.notes !== "" ||
    content.summary !== "" ||
    content.references.length > 0
  );
}

/** Sections that take part in practice: open and with at least one answer. */
export function practiceSections(card: Card): Section[] {
  return card.sections.filter((s) => s.status === "open" && s.items.length > 0);
}

export function unfilledSections(card: Card): Section[] {
  return card.sections.filter((s) => s.status === "open" && s.items.length === 0);
}

export function searchText(card: Pick<Card, "title" | "aliases" | "tags"> & CardContent): string {
  return normalizeText(
    [card.title, ...card.aliases, ...card.tags, ...allTexts(card)].join(" "),
  );
}

// ---------- diffs (used for change summaries and review highlighting) ----------

export type CardSnapshot = Card;

export interface CardDiff {
  addedItemIds: Set<string>;
  changedItemIds: Set<string>;
  removedItems: { sectionKey: string; item: Item }[];
  addedSectionKeys: Set<string>;
  changedFields: string[];
}

function sectionsWithItems(c: CardContent) {
  const m = new Map<string, Item & { sectionKey: string }>();
  for (const s of c.sections) for (const i of s.items) m.set(i.id, { ...i, sectionKey: s.key });
  return m;
}

export function diffCards(before: CardSnapshot | null, after: CardSnapshot): CardDiff {
  const diff: CardDiff = {
    addedItemIds: new Set(),
    changedItemIds: new Set(),
    removedItems: [],
    addedSectionKeys: new Set(),
    changedFields: [],
  };
  const b = before ? sectionsWithItems(before) : new Map();
  const a = sectionsWithItems(after);
  for (const [id, item] of a) {
    const old = b.get(id);
    if (!old) diff.addedItemIds.add(id);
    else if (
      old.text !== item.text ||
      old.sectionKey !== item.sectionKey ||
      JSON.stringify(old.refs ?? []) !== JSON.stringify(item.refs ?? [])
    )
      diff.changedItemIds.add(id);
  }
  for (const [id, item] of b) {
    if (!a.has(id)) diff.removedItems.push({ sectionKey: item.sectionKey, item });
  }
  const beforeSections = new Set(before?.sections.map((s) => s.key) ?? []);
  for (const s of after.sections) {
    if (before && !beforeSections.has(s.key)) diff.addedSectionKeys.add(s.key);
  }
  if (before) {
    const fields: (keyof Card)[] = ["title", "slug", "type", "summary", "notes"];
    for (const f of fields) if (before[f] !== after[f]) diff.changedFields.push(f);
    for (const f of ["aliases", "tags", "references"] as const)
      if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) diff.changedFields.push(f);
    const status = (c: CardContent) =>
      JSON.stringify(c.sections.map((s) => [s.key, s.status, s.prompt]));
    if (status(before) !== status(after)) diff.changedFields.push("sections");
  }
  return diff;
}

/** Human-readable one-liner describing what changed. */
export function summarizeChange(before: CardSnapshot | null, after: CardSnapshot | null): string {
  if (!before && after) {
    const n = after.sections.reduce((acc, s) => acc + s.items.length, 0);
    return after.isStub && n === 0
      ? `Created stub "${after.title}"`
      : `Created "${after.title}" with ${n} answer${n === 1 ? "" : "s"}`;
  }
  if (before && !after) return `Deleted "${before.title}"`;
  if (!before || !after) return "";
  const d = diffCards(before, after);
  const parts: string[] = [];
  const promptOf = (key: string) =>
    after.sections.find((s) => s.key === key)?.prompt ??
    before.sections.find((s) => s.key === key)?.prompt ??
    key;
  const perSection = new Map<string, { added: number; changed: number; removed: number }>();
  const bump = (key: string, f: "added" | "changed" | "removed") => {
    const e = perSection.get(key) ?? { added: 0, changed: 0, removed: 0 };
    e[f]++;
    perSection.set(key, e);
  };
  for (const s of after.sections)
    for (const i of s.items) {
      if (d.addedItemIds.has(i.id)) bump(s.key, "added");
      if (d.changedItemIds.has(i.id)) bump(s.key, "changed");
    }
  for (const r of d.removedItems) bump(r.sectionKey, "removed");
  for (const [key, e] of perSection) {
    const bits: string[] = [];
    if (e.added) bits.push(`+${e.added}`);
    if (e.changed) bits.push(`~${e.changed}`);
    if (e.removed) bits.push(`−${e.removed}`);
    parts.push(`${bits.join(" ")} in "${promptOf(key)}"`);
  }
  for (const k of d.addedSectionKeys) parts.push(`new question "${promptOf(k)}"`);
  if (d.changedFields.includes("title")) parts.push(`renamed "${before.title}" → "${after.title}"`);
  else if (d.changedFields.includes("slug")) parts.push(`slug → ${after.slug}`);
  for (const f of d.changedFields)
    if (!["title", "slug", "sections"].includes(f)) parts.push(`${f} changed`);
  if (d.changedFields.includes("sections") && d.addedSectionKeys.size === 0)
    parts.push("questions changed");
  return parts.join("; ") || "No visible changes";
}
