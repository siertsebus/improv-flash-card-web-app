import { useEffect, useState } from "preact/hooks";
import { createEmptyCard, fsrs, Rating, type Card as FsrsCard, type Grade } from "ts-fsrs";
import { practiceSections } from "../../shared/cards";
import { TEMPLATES, typeLabel } from "../../shared/templates";
import type { PracticeItem, PracticeQueue, SrsState } from "../../shared/types";
import { api, tzParam } from "../api";
import { RichText } from "../components/RichText";
import { toast } from "../components/ui";
import { openOverlay } from "../nav";
import { cards, cardsById } from "../store";
import { Refs } from "./CardView";

const scheduler = fsrs({ enable_fuzz: false });
const RELEARN_WINDOW_MS = 20 * 60_000;

const GRADES: { rating: Grade; label: string; cls: string }[] = [
  { rating: Rating.Again, label: "Again", cls: "again" },
  { rating: Rating.Hard, label: "Hard", cls: "hard" },
  { rating: Rating.Good, label: "Good", cls: "good" },
  { rating: Rating.Easy, label: "Easy", cls: "easy" },
];

function toFsrs(s: SrsState | null): FsrsCard {
  if (!s) return createEmptyCard(new Date());
  return { ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined };
}

function formatInterval(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d}d`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo` : `${(d / 365).toFixed(1)}y`;
}

export function Practice() {
  const [queue, setQueue] = useState<PracticeQueue | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [session, setSession] = useState<PracticeItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  const loadQueue = () =>
    api<PracticeQueue>(`/api/practice/queue?${tzParam()}&types=${types.join(",")}`)
      .then(setQueue)
      .catch((e) => toast(e.message));

  useEffect(() => {
    if (!session) void loadQueue();
  }, [types.join(","), session === null, cards.value.length]);

  if (!session) {
    const total = queue ? queue.items.length : 0;
    return (
      <div class="screen">
        <div class="scroll pad practice-start">
          <h1>Practice</h1>
          {done > 0 && <p class="done-msg">Nice — {done} reviewed this session.</p>}
          {queue && (
            <div class="stats-row">
              <div class="stat">
                <strong>{queue.dueCount}</strong>
                <span>due</span>
              </div>
              <div class="stat">
                <strong>{queue.newCount}</strong>
                <span>new</span>
              </div>
              <div class="stat">
                <strong>{queue.reviewedToday}</strong>
                <span>done today</span>
              </div>
            </div>
          )}
          <h2 class="small-heading">Card types</h2>
          <div class="chips-wrap">
            <button type="button" class={`chip ${types.length === 0 ? "selected" : ""}`} onClick={() => setTypes([])}>
              All
            </button>
            {TEMPLATES.map((t) => (
              <button
                type="button"
                class={`chip ${types.includes(t.key) ? "selected" : ""}`}
                onClick={() =>
                  setTypes(types.includes(t.key) ? types.filter((x) => x !== t.key) : [...types, t.key])
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          {queue && total === 0 && (
            <p class="empty">
              {cards.value.length === 0
                ? "No cards yet. Add some in Browse, or ask your AI assistant to create a few."
                : "Nothing due right now. Come back later, or raise the daily limit in Settings."}
            </p>
          )}
        </div>
        <div class="action-bar">
          <button
            type="button"
            class="btn primary block big"
            disabled={!total}
            onClick={() => {
              setSession(queue!.items);
              setIndex(0);
              setRevealed(false);
              setDone(0);
            }}
          >
            {total ? `Start (${total})` : "Nothing to practise"}
          </button>
        </div>
      </div>
    );
  }

  // Skip items whose card/section disappeared or stopped being practisable (edited meanwhile).
  let current = session[index];
  let card = current && cardsById.value.get(current.cardId);
  let section = card && practiceSections(card).find((s) => s.key === current.sectionKey);
  if (current && !section) {
    queueMicrotask(() => setIndex(index + 1));
    return null;
  }
  if (!current || !card || !section) {
    queueMicrotask(() => {
      setSession(null);
    });
    return null;
  }

  const now = new Date();
  const preview = scheduler.repeat(toFsrs(current.srs), now);

  async function grade(rating: Grade) {
    const item = current;
    const next = preview[rating].card;
    let nextSession = session!;
    if (next.due.getTime() - Date.now() < RELEARN_WINDOW_MS) {
      // Short learning step: see it again later in this session.
      const again: PracticeItem = { ...item, isNew: false, srs: { ...item.srs!, ...serialise(next) } };
      const pos = Math.min(index + 4, nextSession.length);
      nextSession = [...nextSession.slice(0, pos), again, ...nextSession.slice(pos)];
    }
    setSession(nextSession);
    setRevealed(false);
    setDone((d) => d + 1);
    if (index + 1 >= nextSession.length) setSession(null);
    else setIndex(index + 1);
    try {
      await api("/api/practice/review", {
        body: { cardId: item.cardId, sectionKey: item.sectionKey, rating, reviewedAt: now.toISOString(), mode: "single" },
      });
    } catch (e) {
      toast("Couldn't save review: " + (e as Error).message);
    }
  }

  const remaining = session.length - index;

  return (
    <div class="screen practice">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label="End session" onClick={() => setSession(null)}>
          ✕
        </button>
        <div class="topbar-title small muted">{remaining} left</div>
        <div class="topbar-actions">
          <button
            type="button"
            class="icon-btn"
            aria-label="Edit this card"
            onClick={() => openOverlay({ kind: "edit", id: card!.id })}
          >
            ✎
          </button>
        </div>
      </header>
      <div class="scroll pad" onClick={() => !revealed && setRevealed(true)}>
        <div class="flashcard">
          <div class="type-label">
            {typeLabel(card.type)}
            {current.isNew && <span class="badge new">new</span>}
          </div>
          <h1 class="fc-title">{card.title}</h1>
          <div class="fc-question">{section.prompt}</div>
          {!revealed && (
            <p class="small muted center">
              {section.items.length} answer{section.items.length === 1 ? "" : "s"} on this card — recall as many as you can
            </p>
          )}
          {revealed && (
            <>
              <ul class="answers reveal">
                {section.items.map((i) => (
                  <li>
                    <RichText text={i.text} />
                    <Refs refs={i.refs} />
                  </li>
                ))}
              </ul>
              {card.references.length > 0 && <Refs refs={card.references} block />}
            </>
          )}
        </div>
        <div class="bottom-spacer" />
      </div>
      <div class="action-bar">
        {!revealed ? (
          <button type="button" class="btn primary block big" onClick={() => setRevealed(true)}>
            Reveal
          </button>
        ) : (
          <div class="grades">
            {GRADES.map((g) => (
              <button type="button" class={`grade ${g.cls}`} onClick={() => grade(g.rating)}>
                <span>{g.label}</span>
                <small>{formatInterval(preview[g.rating].card.due.getTime() - now.getTime())}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function serialise(c: FsrsCard): SrsState {
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
    last_review: c.last_review?.toISOString() ?? null,
  };
}
