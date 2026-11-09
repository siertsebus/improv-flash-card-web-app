import { useEffect, useState } from "preact/hooks";
import { normalizeText, plainText, searchText, unfilledSections } from "../../shared/cards";
import { TEMPLATES, typeLabel } from "../../shared/templates";
import type { Card, InboxEntry } from "../../shared/types";
import { api } from "../api";
import { timeAgo, toast, TopBar } from "../components/ui";
import { openOverlay, push } from "../nav";
import { cards, dataVersion, inboxCount, titleOf } from "../store";

// Search state survives switching tabs.
let lastQuery = "";
let lastType = "";

export function BrowseHome() {
  const [query, setQuery] = useState(lastQuery);
  const [type, setType] = useState(lastType);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  lastQuery = query;
  lastType = type;

  useEffect(() => {
    if (inboxCount.value === 0 && inbox.length === 0) return;
    api<InboxEntry[]>("/api/inbox")
      .then((list) => {
        setInbox(list);
        inboxCount.value = list.length;
      })
      .catch((e) => toast(e.message));
  }, [dataVersion.value, inboxCount.value]);

  const all = cards.value;
  const results = filterCards(all, query, type);
  const stubs = all.filter((c) => c.isStub).length;
  const unfilled = all.filter((c) => !c.isStub && unfilledSections(c).length > 0).length;
  const searching = query.trim() !== "" || type !== "";

  return (
    <div class="screen">
      <div class="search-head">
        <input
          type="search"
          class="search"
          placeholder={`Search ${all.length} cards…`}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <div class="chips-scroll">
          <button type="button" class={`chip ${type === "" ? "selected" : ""}`} onClick={() => setType("")}>
            All
          </button>
          {TEMPLATES.map((t) => (
            <button
              type="button"
              class={`chip ${type === t.key ? "selected" : ""}`}
              onClick={() => setType(type === t.key ? "" : t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div class="scroll">
        {!searching && inbox.length > 0 && (
          <section class="inbox">
            <div class="inbox-head">
              <h2>
                <span class="dot" /> AI changes to review ({inbox.length})
              </h2>
              <button
                type="button"
                class="btn ghost small"
                onClick={async () => {
                  await api("/api/inbox-reviewed-all", { body: {} });
                  setInbox([]);
                  inboxCount.value = 0;
                }}
              >
                Mark all reviewed
              </button>
            </div>
            {inbox.map((e) => (
              <button type="button" class="list-row" onClick={() => push({ kind: "review", cardId: e.cardId })}>
                <div class="list-main">
                  <strong>{e.cardTitle}</strong>
                  <span class={`badge ${e.isNew ? "new" : ""}`}>{e.isDeleted ? "deleted" : e.isNew ? "new card" : "edited"}</span>
                </div>
                <div class="small muted">
                  {e.summaries.slice(-2).join(" · ")} · {timeAgo(e.lastChangeAt)}
                </div>
              </button>
            ))}
          </section>
        )}

        {!searching && (stubs > 0 || unfilled > 0) && (
          <div class="quick-lists">
            {stubs > 0 && (
              <button type="button" class="chip" onClick={() => push({ kind: "list", list: "stubs" })}>
                {stubs} stub{stubs === 1 ? "" : "s"} to write
              </button>
            )}
            {unfilled > 0 && (
              <button type="button" class="chip" onClick={() => push({ kind: "list", list: "unfilled" })}>
                {unfilled} card{unfilled === 1 ? "" : "s"} with empty questions
              </button>
            )}
          </div>
        )}

        <CardList cards={results} query={query} />
        {results.length === 0 && (
          <div class="empty">
            {all.length === 0 ? "No cards yet." : "No matches."}
            {query.trim() && (
              <div>
                <button
                  type="button"
                  class="btn ghost"
                  onClick={() => openOverlay({ kind: "new", title: capitalize(query.trim()), type: type || undefined })}
                >
                  + Create “{capitalize(query.trim())}”
                </button>
              </div>
            )}
          </div>
        )}
        <div class="bottom-spacer" />
      </div>
      <button type="button" class="fab" aria-label="New card" onClick={() => openOverlay({ kind: "new", type: type || undefined })}>
        +
      </button>
    </div>
  );
}

export function SpecialList({ list }: { list: "stubs" | "unfilled" }) {
  const items =
    list === "stubs" ? cards.value.filter((c) => c.isStub) : cards.value.filter((c) => !c.isStub && unfilledSections(c).length);
  return (
    <div class="screen">
      <TopBar title={list === "stubs" ? "Stubs to write" : "Empty questions"} />
      <div class="scroll">
        <p class="pad small muted">
          {list === "stubs"
            ? "Cards that other cards link to, but that have no content yet. Fill them in here, or ask your AI to write them."
            : "Cards with questions that have no answers yet. Mark a question “not applicable” if it doesn't apply."}
        </p>
        <CardList cards={items} query="" showUnfilled={list === "unfilled"} />
      </div>
    </div>
  );
}

function CardList({ cards: list, query, showUnfilled }: { cards: Card[]; query: string; showUnfilled?: boolean }) {
  return (
    <div class="list">
      {list.map((c) => (
        <button type="button" class="list-row" onClick={() => push({ kind: "card", id: c.id })}>
          <div class="list-main">
            <strong>{c.title}</strong>
            <span class="small muted">{typeLabel(c.type)}</span>
            {c.isStub && <span class="badge">stub</span>}
          </div>
          {showUnfilled ? (
            <div class="small muted">{unfilledSections(c).map((s) => s.prompt).join(" · ")}</div>
          ) : (
            <Snippet card={c} query={query} />
          )}
        </button>
      ))}
    </div>
  );
}

/** Shows the answer that matched the search, so "stethoscope" explains why Doctor is listed. */
function Snippet({ card, query }: { card: Card; query: string }) {
  const q = normalizeText(query);
  if (q) {
    const words = q.split(" ");
    for (const s of card.sections)
      for (const i of s.items) {
        const p = plainText(i.text, titleOf);
        if (words.every((w) => normalizeText(p).includes(w))) return <div class="small muted">“{p}”</div>;
      }
  }
  if (card.summary) return <div class="small muted">{card.summary}</div>;
  const first = card.sections.flatMap((s) => s.items).slice(0, 3);
  if (!first.length) return null;
  return <div class="small muted ellipsis">{first.map((i) => plainText(i.text, titleOf)).join(" · ")}</div>;
}

function filterCards(all: Card[], query: string, type: string): Card[] {
  const q = normalizeText(query);
  const words = q.split(" ").filter(Boolean);
  const scored: { c: Card; score: number }[] = [];
  for (const c of all) {
    if (type && c.type !== type) continue;
    if (!words.length) {
      scored.push({ c, score: 0 });
      continue;
    }
    const title = normalizeText(c.title);
    const names = [title, ...c.aliases.map(normalizeText)];
    const text = searchText({ ...c, sections: c.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, text: plainText(i.text, titleOf) })) })) });
    if (!words.every((w) => text.includes(w))) continue;
    let score = 1;
    if (names.includes(q)) score += 100;
    else if (names.some((n) => n.startsWith(q))) score += 50;
    else if (names.some((n) => words.every((w) => n.includes(w)))) score += 20;
    scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title)).map((s) => s.c);
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
