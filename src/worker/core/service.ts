// Core card logic. Everything that reads or changes cards goes through here: the REST API used
// by the web app, the MCP server used by AI assistants, and the REST tool endpoints all share it.

import {
  formatLink,
  hasContent,
  linkedSlugs,
  mapLinks,
  newId,
  normalizeContent,
  normalizeText,
  plainText,
  searchText,
  slugify,
  summarizeChange,
  unfilledSections,
} from "../../shared/cards";
import { DEFAULT_STUB_TYPE, TEMPLATE_BY_KEY, TEMPLATES } from "../../shared/templates";
import type {
  Card,
  CardContent,
  ChangeEntry,
  ChangeSource,
  InboxEntry,
  Item,
  Reference,
  Section,
  SectionStatus,
} from "../../shared/types";

export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface CardRow {
  id: string;
  slug: string;
  type: string;
  title: string;
  is_stub: number;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToCard(r: CardRow): Card {
  const content = normalizeContent(r.type, JSON.parse(r.content) as CardContent);
  return {
    id: r.id,
    slug: r.slug,
    type: r.type,
    title: r.title,
    isStub: r.is_stub === 1,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...content,
  };
}

function contentOf(c: Card): CardContent {
  return {
    aliases: c.aliases,
    summary: c.summary,
    tags: c.tags,
    sections: c.sections,
    references: c.references,
    notes: c.notes,
  };
}

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

export interface ItemInput {
  text: string;
  refs?: { label: string; url: string }[];
}

export interface CreateCardInput {
  type: string;
  title: string;
  answers?: Record<string, (string | ItemInput)[]>;
  customQuestions?: { prompt: string; answers?: (string | ItemInput)[] }[];
  notApplicable?: string[];
  aliases?: string[];
  summary?: string;
  tags?: string[];
  references?: { label: string; url: string }[];
  notes?: string;
}

/**
 * A unit of work: loads all cards of the owner once, applies mutations in memory, then writes
 * everything (cards, links, revisions) in one atomic D1 batch.
 */
export class CardService {
  private cards: Map<string, Card> | null = null;
  private original = new Map<string, Card | null>();
  private actions: string[] = [];
  private batchId = newId(12);

  constructor(
    private db: D1Database,
    private ownerId: string,
    private source: ChangeSource,
  ) {}

  // ---------- loading & lookup ----------

  async all(): Promise<Card[]> {
    if (!this.cards) {
      const { results } = await this.db
        .prepare("SELECT * FROM cards WHERE owner_id = ?")
        .bind(this.ownerId)
        .all<CardRow>();
      this.cards = new Map(results.map((r) => [r.id, rowToCard(r)]));
    }
    return [...this.cards.values()];
  }

  private async map(): Promise<Map<string, Card>> {
    await this.all();
    return this.cards!;
  }

  async bySlug(slug: string): Promise<Card | undefined> {
    return (await this.all()).find((c) => c.slug === slug);
  }

  async byId(id: string): Promise<Card | undefined> {
    return (await this.map()).get(id);
  }

  /** Find by exact slug, then by title or alias. */
  async find(ref: string): Promise<Card | undefined> {
    const cards = await this.all();
    const r = ref.trim();
    const bySlug = cards.find((c) => c.slug === r || c.id === r) ?? cards.find((c) => c.slug === slugify(r));
    if (bySlug) return bySlug;
    const n = normalizeText(r);
    return (
      cards.find((c) => normalizeText(c.title) === n) ??
      cards.find((c) => c.aliases.some((a) => normalizeText(a) === n))
    );
  }

  async require(ref: string): Promise<Card> {
    const card = await this.find(ref);
    if (!card) {
      const suggestions = (await this.search(ref, {}, 5)).map((s) => s.slug);
      throw new UserError(
        `No card found for "${ref}".` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
        404,
      );
    }
    return card;
  }

  async backlinks(slug: string): Promise<{ slug: string; title: string; type: string }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT c.slug, c.title, c.type FROM links l JOIN cards c ON c.id = l.from_id WHERE l.owner_id = ? AND l.to_slug = ? ORDER BY c.title",
      )
      .bind(this.ownerId, slug)
      .all<{ slug: string; title: string; type: string }>();
    return results;
  }

  // ---------- read operations ----------

  getCardTypes() {
    return TEMPLATES.map((t) => ({
      type: t.key,
      label: t.label,
      description: t.description,
      examples: t.examples,
      questions: t.questions.map((q) => ({
        key: q.key,
        prompt: q.prompt,
        ...(q.linkHint ? { usuallyLinksTo: q.linkHint } : {}),
      })),
    }));
  }

  async search(query: string, filter: { type?: string; tag?: string } = {}, limit = 15) {
    const words = normalizeText(query).split(" ").filter(Boolean);
    const qn = normalizeText(query);
    const scored: { card: Card; score: number }[] = [];
    for (const card of await this.all()) {
      if (filter.type && card.type !== filter.type) continue;
      if (filter.tag && !card.tags.includes(slugify(filter.tag))) continue;
      if (!words.length) {
        scored.push({ card, score: 0 });
        continue;
      }
      const title = normalizeText(card.title);
      const aliases = card.aliases.map(normalizeText);
      const text = searchText(card);
      let score = 0;
      if (title === qn || aliases.includes(qn)) score += 100;
      else if (title.startsWith(qn)) score += 50;
      else if (title.includes(qn) || aliases.some((a) => a.includes(qn))) score += 30;
      for (const w of words) {
        if (title.includes(w)) score += 10;
        else if (aliases.some((a) => a.includes(w))) score += 8;
        else if (text.includes(w)) score += 3;
        else score -= 5;
      }
      if (score > 0) scored.push({ card, score });
    }
    scored.sort((a, b) => b.score - a.score || a.card.title.localeCompare(b.card.title));
    return scored.slice(0, limit).map(({ card }) => ({
      slug: card.slug,
      title: card.title,
      type: card.type,
      isStub: card.isStub,
      aliases: card.aliases,
      summary: card.summary,
      answerCount: card.sections.reduce((n, s) => n + s.items.length, 0),
    }));
  }

  /** A card in a shape convenient for AI assistants (links shown with titles, ids visible). */
  async describeCard(ref: string) {
    const card = await this.require(ref);
    const cards = await this.all();
    const titleOf = (slug: string) => cards.find((c) => c.slug === slug)?.title;
    const links = [...linkedSlugs(card)].map((slug) => {
      const target = cards.find((c) => c.slug === slug);
      return { slug, title: target?.title ?? slug, isStub: target?.isStub ?? true };
    });
    return {
      ...card,
      sections: card.sections.map((s) => ({
        ...s,
        items: s.items.map((i) => ({ ...i, plain: plainText(i.text, titleOf) })),
      })),
      linksTo: links,
      linkedFrom: await this.backlinks(card.slug),
    };
  }

  async listStubs() {
    const stubs = (await this.all()).filter((c) => c.isStub);
    const out = [];
    for (const s of stubs) {
      const from = await this.backlinks(s.slug);
      out.push({ slug: s.slug, title: s.title, type: s.type, linkedFrom: from.map((f) => f.title) });
    }
    return out;
  }

  async listUnfilled() {
    return (await this.all())
      .filter((c) => !c.isStub)
      .map((c) => ({
        slug: c.slug,
        title: c.title,
        type: c.type,
        emptyQuestions: unfilledSections(c).map((s) => ({ key: s.key, prompt: s.prompt })),
      }))
      .filter((c) => c.emptyQuestions.length > 0);
  }

  // ---------- mutation plumbing ----------

  private async track(card: Card) {
    if (!this.original.has(card.id)) this.original.set(card.id, clone(card));
  }

  private async put(card: Card) {
    const map = await this.map();
    if (!this.original.has(card.id)) this.original.set(card.id, map.get(card.id) ? clone(map.get(card.id)!) : null);
    const content = normalizeContent(card.type, contentOf(card));
    Object.assign(card, content);
    map.set(card.id, card);
  }

  private async remove(card: Card) {
    const map = await this.map();
    if (!this.original.has(card.id)) this.original.set(card.id, clone(card));
    map.delete(card.id);
  }

  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    const cards = await this.all();
    const taken = new Set(cards.filter((c) => c.id !== exceptId).map((c) => c.slug));
    let slug = slugify(base);
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(base)}-${n}`;
    return slug;
  }

  private async newCard(type: string, title: string, isStub: boolean): Promise<Card> {
    const t = now();
    const card: Card = {
      id: newId(),
      slug: await this.uniqueSlug(title),
      type,
      title: title.trim(),
      isStub,
      version: 0,
      createdAt: t,
      updatedAt: t,
      ...normalizeContent(type, {}),
    };
    await this.put(card);
    return card;
  }

  /**
   * Normalise every [[link]] in `text`: targets may be a slug, a title or an alias. Unknown
   * targets become stubs (typed by `hintType` when given).
   */
  async resolveLinks(text: string, hintType?: string): Promise<string> {
    const tokens = [...text.matchAll(/\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g)];
    if (!tokens.length) return text;
    const replacements = new Map<string, string>();
    for (const m of tokens) {
      const target = m[1].trim();
      const label = m[2]?.trim();
      let card = await this.find(target);
      if (!card) {
        const title = /^[a-z0-9-]+$/.test(target) && target.includes("-")
          ? capitalize(target.replace(/-/g, " "))
          : target;
        card = await this.newCard(
          hintType && TEMPLATE_BY_KEY[hintType] ? hintType : DEFAULT_STUB_TYPE,
          title,
          true,
        );
      } else if (
        card.isStub && !hasContent(card) && card.type === DEFAULT_STUB_TYPE &&
        hintType && hintType !== card.type && TEMPLATE_BY_KEY[hintType]
      ) {
        // A stub created without a type hint gets a better type once it's linked from a typed question.
        await this.track(card);
        card.type = hintType;
        await this.put(card);
      }
      const shown = label ?? (normalizeText(target) === normalizeText(card.title) || target === card.slug ? undefined : target);
      replacements.set(m[0], formatLink(card.slug, shown));
    }
    return text.replace(/\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g, (whole) => replacements.get(whole) ?? whole);
  }

  private async makeItem(input: string | ItemInput, hintType?: string): Promise<Item> {
    const i = typeof input === "string" ? { text: input } : input;
    const item: Item = { id: newId(), text: await this.resolveLinks(i.text.trim(), hintType) };
    if (i.refs?.length) item.refs = i.refs.map((r) => ({ id: newId(), label: r.label, url: r.url }));
    return item;
  }

  private findSection(card: Card, keyOrPrompt: string): Section {
    const k = keyOrPrompt.trim();
    const s =
      card.sections.find((s) => s.key === k) ??
      card.sections.find((s) => normalizeText(s.prompt) === normalizeText(k)) ??
      card.sections.find((s) => normalizeText(s.prompt).includes(normalizeText(k)));
    if (!s)
      throw new UserError(
        `Card "${card.title}" has no question "${keyOrPrompt}". Its questions are: ` +
          card.sections.map((s) => `${s.key} ("${s.prompt}")`).join(", ") +
          ". Use add_custom_question only if the user explicitly asked for a new question.",
      );
    return s;
  }

  private findItem(card: Card, itemId: string): { section: Section; index: number; item: Item } {
    for (const section of card.sections) {
      const index = section.items.findIndex((i) => i.id === itemId);
      if (index >= 0) return { section, index, item: section.items[index] };
    }
    throw new UserError(`Card "${card.title}" has no answer with id "${itemId}". Use get_card to see the ids.`);
  }

  private hintFor(card: Card, sectionKey: string) {
    return TEMPLATE_BY_KEY[card.type]?.questions.find((q) => q.key === sectionKey)?.linkHint;
  }

  private markFilled(card: Card) {
    if (card.isStub && hasContent(card)) card.isStub = false;
  }

  /** Write all pending changes atomically. Returns the batch id (undo handle). */
  async commit(action: string): Promise<string | null> {
    this.actions.push(action);
    const map = await this.map();
    const stmts: D1PreparedStatement[] = [];
    const t = now();
    const revisions: { cardId: string; before: Card | null; after: Card | null }[] = [];

    for (const [id, before] of this.original) {
      const after = map.get(id) ?? null;
      if (before && after && JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after) {
        after.version = (before?.version ?? 0) + 1;
        after.updatedAt = t;
        const content = JSON.stringify(contentOf(after));
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO cards (id, owner_id, slug, type, title, is_stub, content, search_text, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, type=excluded.type, title=excluded.title,
                 is_stub=excluded.is_stub, content=excluded.content, search_text=excluded.search_text,
                 version=excluded.version, updated_at=excluded.updated_at`,
            )
            .bind(
              id, this.ownerId, after.slug, after.type, after.title, after.isStub ? 1 : 0, content,
              searchText(after), after.version, after.createdAt, after.updatedAt,
            ),
        );
      } else {
        stmts.push(this.db.prepare("DELETE FROM cards WHERE id = ?").bind(id));
        stmts.push(this.db.prepare("DELETE FROM srs WHERE card_id = ?").bind(id));
      }
      stmts.push(this.db.prepare("DELETE FROM links WHERE from_id = ?").bind(id));
      if (after)
        for (const slug of linkedSlugs(after))
          stmts.push(
            this.db
              .prepare("INSERT OR IGNORE INTO links (owner_id, from_id, to_slug) VALUES (?, ?, ?)")
              .bind(this.ownerId, id, slug),
          );
      revisions.push({ cardId: id, before, after });
    }
    if (!revisions.length) return null;

    for (const r of revisions) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO revisions (owner_id, batch_id, card_id, source, action, summary, before, after, created_at, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            this.ownerId, this.batchId, r.cardId, this.source, this.actions.join(", "),
            summarizeChange(r.before, r.after),
            r.before ? JSON.stringify(r.before) : null,
            r.after ? JSON.stringify(r.after) : null,
            t, this.source === "ai" ? null : t,
          ),
      );
      // A manual edit counts as reviewing whatever the AI did to that card.
      if (this.source === "app")
        stmts.push(
          this.db
            .prepare("UPDATE revisions SET reviewed_at = ? WHERE card_id = ? AND reviewed_at IS NULL")
            .bind(t, r.cardId),
        );
    }
    await this.db.batch(stmts);
    const batch = this.batchId;
    this.original.clear();
    this.actions = [];
    this.batchId = newId(12);
    return batch;
  }

  // ---------- write operations ----------

  async createCard(input: CreateCardInput) {
    if (!TEMPLATE_BY_KEY[input.type])
      throw new UserError(`Unknown card type "${input.type}". Use one of: ${TEMPLATES.map((t) => t.key).join(", ")}`);
    const title = input.title.trim();
    if (!title) throw new UserError("Title is required");
    const existing = await this.find(title);
    let card: Card;
    if (existing && !existing.isStub)
      throw new UserError(
        `A card "${existing.title}" (${existing.slug}) already exists. Add to it with add_answers instead.`,
        409,
      );
    if (existing) {
      // Fill in the stub that other cards already link to.
      await this.track(existing);
      card = existing;
      card.type = input.type;
      card.title = title;
      Object.assign(card, normalizeContent(card.type, contentOf(card)));
    } else {
      card = await this.newCard(input.type, title, false);
    }
    card.isStub = false;
    card.aliases = [...card.aliases, ...(input.aliases ?? [])];
    card.summary = input.summary ?? card.summary;
    card.tags = [...card.tags, ...(input.tags ?? [])];
    card.notes = input.notes ? await this.resolveLinks(input.notes) : card.notes;
    card.references = [
      ...card.references,
      ...(input.references ?? []).map((r) => ({ id: newId(), label: r.label, url: r.url })),
    ];
    for (const [key, answers] of Object.entries(input.answers ?? {})) {
      const section = this.findSection(card, key);
      for (const a of answers) section.items.push(await this.makeItem(a, this.hintFor(card, section.key)));
    }
    for (const q of input.customQuestions ?? []) {
      const section = this.addSection(card, q.prompt);
      for (const a of q.answers ?? []) section.items.push(await this.makeItem(a));
    }
    for (const key of input.notApplicable ?? []) this.findSection(card, key).status = "not_applicable";
    await this.put(card);
    const batch = await this.commit(existing ? "filled stub" : "created card");
    return { card: await this.describeCard(card.slug), changeId: batch };
  }

  async addItems(ref: string, sectionKey: string, items: (string | ItemInput)[]) {
    const card = await this.require(ref);
    await this.track(card);
    const section = this.findSection(card, sectionKey);
    const existing = new Set(section.items.map((i) => normalizeText(i.text)));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const input of items) {
      const item = await this.makeItem(input, this.hintFor(card, section.key));
      const key = normalizeText(item.text);
      if (!key || existing.has(key)) {
        skipped.push(item.text);
        continue;
      }
      existing.add(key);
      section.items.push(item);
      added.push(item.text);
    }
    if (added.length && section.status === "not_applicable") section.status = "open";
    this.markFilled(card);
    await this.put(card);
    const changeId = await this.commit("added answers");
    return { card: card.slug, question: section.prompt, added, skippedDuplicates: skipped, changeId };
  }

  async updateItem(ref: string, itemId: string, text: string) {
    const card = await this.require(ref);
    await this.track(card);
    const { section, item } = this.findItem(card, itemId);
    item.text = await this.resolveLinks(text.trim(), this.hintFor(card, section.key));
    await this.put(card);
    return { card: card.slug, item, changeId: await this.commit("edited answer") };
  }

  async removeItem(ref: string, itemId: string) {
    const card = await this.require(ref);
    await this.track(card);
    const { section, index, item } = this.findItem(card, itemId);
    section.items.splice(index, 1);
    await this.put(card);
    return { card: card.slug, removed: item.text, changeId: await this.commit("removed answer") };
  }

  async moveItem(ref: string, itemId: string, toSection?: string, position?: number) {
    const card = await this.require(ref);
    await this.track(card);
    const { section, index, item } = this.findItem(card, itemId);
    const target = toSection ? this.findSection(card, toSection) : section;
    section.items.splice(index, 1);
    const pos = Math.max(0, Math.min(position ?? target.items.length, target.items.length));
    target.items.splice(pos, 0, item);
    await this.put(card);
    return { card: card.slug, movedTo: target.prompt, changeId: await this.commit("moved answer") };
  }

  async addReference(ref: string, ref_: { label: string; url: string }, itemId?: string) {
    const card = await this.require(ref);
    await this.track(card);
    const r: Reference = { id: newId(), label: ref_.label.trim() || ref_.url, url: ref_.url.trim() };
    if (itemId) {
      const { item } = this.findItem(card, itemId);
      item.refs = [...(item.refs ?? []), r];
    } else card.references.push(r);
    this.markFilled(card);
    await this.put(card);
    return { card: card.slug, reference: r, changeId: await this.commit("added reference") };
  }

  async removeReference(ref: string, referenceId: string) {
    const card = await this.require(ref);
    await this.track(card);
    const before = card.references.length;
    card.references = card.references.filter((r) => r.id !== referenceId);
    let found = before !== card.references.length;
    for (const s of card.sections)
      for (const i of s.items)
        if (i.refs?.some((r) => r.id === referenceId)) {
          i.refs = i.refs.filter((r) => r.id !== referenceId);
          found = true;
        }
    if (!found) throw new UserError(`No reference with id "${referenceId}" on "${card.title}"`);
    await this.put(card);
    return { card: card.slug, changeId: await this.commit("removed reference") };
  }

  private addSection(card: Card, prompt: string): Section {
    const p = prompt.trim();
    if (!p) throw new UserError("Question text is required");
    const dup = card.sections.find((s) => normalizeText(s.prompt) === normalizeText(p));
    if (dup) return dup;
    const keys = new Set(card.sections.map((s) => s.key));
    let key = slugify(p).slice(0, 30);
    for (let n = 2; keys.has(key); n++) key = `${slugify(p).slice(0, 30)}-${n}`;
    const section: Section = { key, prompt: p, origin: "custom", status: "open", items: [] };
    card.sections.push(section);
    return section;
  }

  async addCustomQuestion(ref: string, prompt: string, answers: (string | ItemInput)[] = []) {
    const card = await this.require(ref);
    await this.track(card);
    const section = this.addSection(card, prompt);
    for (const a of answers) section.items.push(await this.makeItem(a));
    this.markFilled(card);
    await this.put(card);
    return { card: card.slug, question: { key: section.key, prompt: section.prompt }, changeId: await this.commit("added question") };
  }

  async removeCustomQuestion(ref: string, sectionKey: string) {
    const card = await this.require(ref);
    await this.track(card);
    const section = this.findSection(card, sectionKey);
    if (section.origin === "template")
      throw new UserError(`"${section.prompt}" is a template question; mark it not_applicable instead.`);
    card.sections = card.sections.filter((s) => s !== section);
    await this.put(card);
    return { card: card.slug, removed: section.prompt, changeId: await this.commit("removed question") };
  }

  async setSectionStatus(ref: string, sectionKey: string, status: SectionStatus) {
    const card = await this.require(ref);
    await this.track(card);
    const section = this.findSection(card, sectionKey);
    section.status = status;
    await this.put(card);
    return { card: card.slug, question: section.prompt, status, changeId: await this.commit("question status") };
  }

  async updateCardFields(
    ref: string,
    fields: { aliases?: string[]; summary?: string; tags?: string[]; notes?: string },
  ) {
    const card = await this.require(ref);
    await this.track(card);
    if (fields.aliases) card.aliases = fields.aliases;
    if (fields.summary !== undefined) card.summary = fields.summary;
    if (fields.tags) card.tags = fields.tags;
    if (fields.notes !== undefined) card.notes = await this.resolveLinks(fields.notes);
    this.markFilled(card);
    await this.put(card);
    return { card: card.slug, changeId: await this.commit("edited details") };
  }

  /** Rewrite links pointing at `fromSlug` in every card, using `fn` to produce the new link text. */
  private async rewriteLinksTo(fromSlug: string, fn: (label: string | undefined) => string) {
    for (const other of await this.all()) {
      if (!linkedSlugs(other).has(fromSlug)) continue;
      await this.track(other);
      const rewrite = (text: string) =>
        mapLinks(text, (t) => (t.target === fromSlug ? fn(t.label) : formatLink(t.target, t.label)));
      for (const s of other.sections) for (const i of s.items) i.text = rewrite(i.text);
      other.notes = rewrite(other.notes);
      other.summary = rewrite(other.summary);
      await this.put(other);
    }
  }

  async renameCard(ref: string, title: string, slug?: string) {
    const card = await this.require(ref);
    await this.track(card);
    const oldSlug = card.slug;
    const clash = await this.find(title);
    if (clash && clash.id !== card.id && !clash.isStub)
      throw new UserError(`Another card is already called "${clash.title}". Use merge_cards to combine them.`, 409);
    card.title = title.trim();
    const newSlug = await this.uniqueSlug(slug ?? title, card.id);
    if (newSlug !== oldSlug) {
      card.slug = newSlug;
      await this.put(card);
      await this.rewriteLinksTo(oldSlug, (label) => formatLink(newSlug, label));
    } else await this.put(card);
    return { card: card.slug, title: card.title, changeId: await this.commit("renamed card") };
  }

  async changeType(ref: string, type: string) {
    if (!TEMPLATE_BY_KEY[type]) throw new UserError(`Unknown card type "${type}"`);
    const card = await this.require(ref);
    await this.track(card);
    card.type = type;
    await this.put(card);
    return { card: card.slug, type, sections: card.sections.map((s) => s.prompt), changeId: await this.commit("changed type") };
  }

  async mergeCards(sourceRef: string, targetRef: string) {
    const source = await this.require(sourceRef);
    const target = await this.require(targetRef);
    if (source.id === target.id) throw new UserError("Cannot merge a card into itself");
    await this.track(target);
    for (const s of source.sections) {
      if (!s.items.length) continue;
      const dest = target.sections.find((t) => t.key === s.key) ?? this.addSection(target, s.prompt);
      const seen = new Set(dest.items.map((i) => normalizeText(i.text)));
      for (const i of s.items) if (!seen.has(normalizeText(i.text))) dest.items.push(i);
    }
    target.aliases = [...target.aliases, source.title, ...source.aliases];
    target.tags = [...target.tags, ...source.tags];
    target.references = [...target.references, ...source.references];
    target.notes = [target.notes, source.notes].filter(Boolean).join("\n\n");
    target.isStub = target.isStub && source.isStub;
    await this.put(target);
    await this.remove(source);
    await this.rewriteLinksTo(source.slug, (label) => formatLink(target.slug, label ?? source.title));
    return { card: target.slug, merged: source.title, changeId: await this.commit("merged cards") };
  }

  async deleteCard(ref: string) {
    const card = await this.require(ref);
    await this.remove(card);
    await this.rewriteLinksTo(card.slug, (label) => label ?? card.title);
    return { deleted: card.title, changeId: await this.commit("deleted card") };
  }

  /** Full replace from the app editor, with optimistic concurrency. */
  async saveCard(
    id: string,
    expectedVersion: number,
    data: { title: string; type: string; slug?: string } & Partial<CardContent>,
  ) {
    const card = await this.byId(id);
    if (!card) throw new UserError("Card not found", 404);
    if (card.version !== expectedVersion)
      throw new UserError("This card was changed elsewhere in the meantime. Reload it and try again.", 409, {
        current: card,
      });
    if (!TEMPLATE_BY_KEY[data.type]) throw new UserError(`Unknown card type "${data.type}"`);
    await this.track(card);
    const oldSlug = card.slug;
    const wasStub = card.isStub;
    const title = data.title.trim();
    if (!title) throw new UserError("Title is required");
    const clash = (await this.all()).find(
      (c) => c.id !== card.id && normalizeText(c.title) === normalizeText(title) && !c.isStub,
    );
    if (clash) throw new UserError(`Another card is already called "${clash.title}"`, 409);
    card.title = title;
    card.type = data.type;
    const content = normalizeContent(data.type, { ...contentOf(card), ...data });
    for (const s of content.sections) {
      const hint = TEMPLATE_BY_KEY[data.type]?.questions.find((q) => q.key === s.key)?.linkHint;
      for (const i of s.items) {
        i.id ||= newId();
        i.text = await this.resolveLinks(i.text.trim(), hint);
        for (const r of i.refs ?? []) r.id ||= newId();
      }
    }
    content.notes = await this.resolveLinks(content.notes);
    for (const r of content.references) r.id ||= newId();
    Object.assign(card, content);
    card.isStub = wasStub && !hasContent(card);
    const titleChanged = this.original.get(id)?.title !== card.title;
    const newSlug = data.slug
      ? await this.uniqueSlug(data.slug, card.id)
      : titleChanged
        ? await this.uniqueSlug(card.title, card.id)
        : oldSlug;
    card.slug = newSlug;
    await this.put(card);
    if (newSlug !== oldSlug) await this.rewriteLinksTo(oldSlug, (label) => formatLink(newSlug, label));
    const changeId = await this.commit("edited card");
    return { card: (await this.byId(id))!, changeId };
  }

  async createBlankCard(type: string, title: string) {
    return this.createCard({ type, title });
  }

  // ---------- history, undo & AI review ----------

  async recentChanges(limit = 30, source?: ChangeSource): Promise<ChangeEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.id, r.batch_id, r.card_id, r.source, r.action, r.summary, r.created_at, r.reviewed_at, r.undone_at,
                COALESCE(c.title, json_extract(r.before, '$.title'), json_extract(r.after, '$.title')) AS title,
                COALESCE(c.slug, json_extract(r.after, '$.slug'), json_extract(r.before, '$.slug')) AS slug
         FROM revisions r LEFT JOIN cards c ON c.id = r.card_id
         WHERE r.owner_id = ? ${source ? "AND r.source = ?" : ""}
         ORDER BY r.id DESC LIMIT ?`,
      )
      .bind(...(source ? [this.ownerId, source, limit] : [this.ownerId, limit]))
      .all<Record<string, string | number | null>>();
    return results.map((r) => ({
      id: r.id as number,
      batchId: r.batch_id as string,
      cardId: r.card_id as string,
      cardTitle: r.title as string,
      cardSlug: r.slug as string,
      source: r.source as ChangeSource,
      action: r.action as string,
      summary: r.summary as string,
      createdAt: r.created_at as string,
      reviewedAt: r.reviewed_at as string | null,
      undoneAt: r.undone_at as string | null,
    }));
  }

  async undoChange(batchId: string, force = false) {
    const { results: revs } = await this.db
      .prepare("SELECT * FROM revisions WHERE owner_id = ? AND batch_id = ? ORDER BY id DESC")
      .bind(this.ownerId, batchId)
      .all<{ id: number; card_id: string; before: string | null; undone_at: string | null; summary: string }>();
    if (!revs.length) throw new UserError(`No change with id "${batchId}"`, 404);
    if (revs.some((r) => r.undone_at)) throw new UserError("This change was already undone", 409);
    const maxId = Math.max(...revs.map((r) => r.id));
    const cardIds = [...new Set(revs.map((r) => r.card_id))];
    const later = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM revisions WHERE owner_id = ? AND id > ? AND undone_at IS NULL
         AND card_id IN (${cardIds.map(() => "?").join(",")})`,
      )
      .bind(this.ownerId, maxId, ...cardIds)
      .first<{ n: number }>();
    if (later && later.n > 0 && !force)
      throw new UserError(
        `These cards were changed ${later.n} more time(s) afterwards; undoing will also revert those later edits.`,
        409,
        { laterChanges: later.n, needsForce: true },
      );
    for (const r of revs) {
      const current = await this.byId(r.card_id);
      if (r.before) {
        const snapshot = JSON.parse(r.before) as Card;
        if (current) {
          await this.track(current);
          Object.assign(current, snapshot, { version: current.version });
          await this.put(current);
        } else {
          snapshot.version = 0;
          await this.put(snapshot);
          this.original.set(snapshot.id, null);
        }
      } else if (current) await this.remove(current);
    }
    const t = now();
    const undoBatch = await this.commit(`undo: ${revs[revs.length - 1].summary}`);
    await this.db
      .prepare("UPDATE revisions SET undone_at = ?, reviewed_at = COALESCE(reviewed_at, ?) WHERE batch_id = ?")
      .bind(t, t, batchId)
      .run();
    // An undo is itself already reviewed; it doesn't need to sit in the AI inbox.
    if (undoBatch)
      await this.db.prepare("UPDATE revisions SET reviewed_at = ? WHERE batch_id = ?").bind(t, undoBatch).run();
    return { undone: batchId, changeId: undoBatch };
  }

  async inbox(): Promise<InboxEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.card_id, r.summary, r.created_at, r.before IS NULL AS is_new, r.after IS NULL AS is_deleted,
                COALESCE(c.title, json_extract(r.before, '$.title'), json_extract(r.after, '$.title')) AS title,
                COALESCE(c.slug, json_extract(r.after, '$.slug'), json_extract(r.before, '$.slug')) AS slug,
                c.id IS NULL AS gone
         FROM revisions r LEFT JOIN cards c ON c.id = r.card_id
         WHERE r.owner_id = ? AND r.source = 'ai' AND r.reviewed_at IS NULL AND r.undone_at IS NULL
         ORDER BY r.id`,
      )
      .bind(this.ownerId)
      .all<Record<string, string | number>>();
    const byCard = new Map<string, InboxEntry>();
    for (const r of results) {
      const id = r.card_id as string;
      const e =
        byCard.get(id) ??
        ({
          cardId: id,
          cardSlug: r.slug as string,
          cardTitle: r.title as string,
          isNew: r.is_new === 1,
          isDeleted: false,
          summaries: [],
          firstChangeAt: r.created_at as string,
          lastChangeAt: r.created_at as string,
        } satisfies InboxEntry);
      e.summaries.push(r.summary as string);
      e.lastChangeAt = r.created_at as string;
      e.isDeleted = r.gone === 1;
      byCard.set(id, e);
    }
    return [...byCard.values()].reverse();
  }

  /** The card as it was before the first unreviewed AI change, for highlighting what's new. */
  async inboxDetail(cardId: string) {
    const first = await this.db
      .prepare(
        `SELECT before FROM revisions WHERE owner_id = ? AND card_id = ? AND source = 'ai'
         AND reviewed_at IS NULL AND undone_at IS NULL ORDER BY id LIMIT 1`,
      )
      .bind(this.ownerId, cardId)
      .first<{ before: string | null }>();
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT batch_id FROM revisions WHERE owner_id = ? AND card_id = ? AND source = 'ai'
         AND reviewed_at IS NULL AND undone_at IS NULL ORDER BY id DESC`,
      )
      .bind(this.ownerId, cardId)
      .all<{ batch_id: string }>();
    const current = await this.byId(cardId);
    return {
      before: first?.before ? (JSON.parse(first.before) as Card) : null,
      current: current ?? null,
      batchIds: results.map((r) => r.batch_id),
    };
  }

  /** Put one card back to how it was before its unreviewed AI changes (other cards untouched). */
  async revertAiChanges(cardId: string) {
    const { before } = await this.inboxDetail(cardId);
    const current = await this.byId(cardId);
    const linked = current ? (await this.backlinks(current.slug)).some((b) => b.slug !== current.slug) : false;
    if (!before && current && linked) {
      // Other cards link here: keep it as an empty stub instead of breaking their links.
      await this.track(current);
      Object.assign(current, normalizeContent(current.type, {}), { isStub: true });
      await this.put(current);
    } else if (!before) {
      if (current) {
        await this.remove(current);
        await this.rewriteLinksTo(current.slug, (label) => label ?? current.title);
      }
    } else if (current) {
      await this.track(current);
      const oldSlug = current.slug;
      Object.assign(current, structuredClone(before), { version: current.version });
      await this.put(current);
      if (oldSlug !== current.slug) await this.rewriteLinksTo(oldSlug, (label) => formatLink(current.slug, label));
    } else {
      await this.put({ ...structuredClone(before), version: 0 });
      this.original.set(before.id, null);
    }
    const changeId = await this.commit("reverted AI changes");
    await this.markReviewed(cardId);
    return { changeId };
  }

  async markReviewed(cardId?: string) {
    const t = now();
    if (cardId)
      await this.db
        .prepare("UPDATE revisions SET reviewed_at = ? WHERE owner_id = ? AND card_id = ? AND reviewed_at IS NULL")
        .bind(t, this.ownerId, cardId)
        .run();
    else
      await this.db
        .prepare("UPDATE revisions SET reviewed_at = ? WHERE owner_id = ? AND reviewed_at IS NULL")
        .bind(t, this.ownerId)
        .run();
    return { ok: true };
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
