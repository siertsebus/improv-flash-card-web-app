import { useEffect, useState } from "preact/hooks";
import { diffCards, formatLink, type CardDiff } from "../../shared/cards";
import { typeLabel } from "../../shared/templates";
import type { Card, Item, Reference } from "../../shared/types";
import { saveCard, undo } from "../actions";
import { api } from "../api";
import { findMentions, RichText } from "../components/RichText";
import { choose, confirmSheet, toast, TopBar } from "../components/ui";
import { back, openCard, openOverlay } from "../nav";
import { backlinkIndex, cardsById, inboxCount, refresh } from "../store";

interface Props {
  id: string;
  /** Review mode: highlight what the AI changed since `before`, with review actions. */
  review?: boolean;
}

export function CardView({ id, review }: Props) {
  const card = cardsById.value.get(id);
  const [detail, setDetail] = useState<{ before: Card | null; batchIds: string[] } | null>(null);

  useEffect(() => {
    if (!review) return;
    api(`/api/inbox/${id}`).then(setDetail).catch((e) => toast(e.message));
  }, [id, review, card?.version]);

  if (!card)
    return (
      <div class="screen">
        <TopBar title="Card not found" />
        <p class="empty">This card no longer exists.</p>
        {review && (
          <div class="pad">
            <button type="button" class="btn block" onClick={() => markReviewed(id)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    );

  // After a manual edit the server marks the AI changes reviewed; then there's nothing to highlight.
  const pending = !!detail && detail.batchIds.length > 0;
  const diff = review && detail && pending ? diffCards(detail.before, card) : null;
  const isNewCard = review && pending && !detail!.before;
  const backlinks = backlinkIndex.value.get(card.slug) ?? [];

  const linkMention = (item: Item) => (m: { from: number; to: number; card: Card }) => {
    const shown = item.text.slice(m.from, m.to);
    choose({
      title: `Link “${shown}” to ${m.card.title}?`,
      options: [
        {
          label: `Link to ${m.card.title}`,
          run: () => {
            const text =
              item.text.slice(0, m.from) +
              formatLink(m.card.slug, shown === m.card.title ? undefined : shown) +
              item.text.slice(m.to);
            const next = structuredClone(card);
            for (const s of next.sections) for (const i of s.items) if (i.id === item.id) i.text = text;
            void saveCard(next);
          },
        },
        { label: "Open " + m.card.title, run: () => openCard(m.card.id) },
        { label: "Cancel", run: () => {} },
      ],
    });
  };

  return (
    <div class="screen">
      <TopBar
        title={review ? "Review AI change" : ""}
        actions={
          <button type="button" class="icon-btn" aria-label="Edit card" onClick={() => openOverlay({ kind: "edit", id })}>
            ✎
          </button>
        }
      />
      <div class="scroll pad">
        <div class="card-head">
          <div class="type-label">
            {typeLabel(card.type)}
            {card.isStub && <span class="badge">stub</span>}
            {isNewCard && <span class="badge new">new</span>}
          </div>
          <h1>{card.title}</h1>
          {card.summary && <p class="muted">{card.summary}</p>}
          {card.aliases.length > 0 && <p class="small muted">Also: {card.aliases.join(", ")}</p>}
          {card.tags.length > 0 && (
            <div class="tags">
              {card.tags.map((t) => (
                <span class="tag">#{t}</span>
              ))}
            </div>
          )}
        </div>

        {card.isStub && !card.sections.some((s) => s.items.length) && (
          <p class="muted">
            Nothing written yet. Tap ✎ to fill it in, or ask the AI to write it.
          </p>
        )}

        {card.sections.map((s) => {
          const removed = diff?.removedItems.filter((r) => r.sectionKey === s.key) ?? [];
          if (s.status === "not_applicable")
            return (
              <section class="section na">
                <h2>{s.prompt}</h2>
                <p class="small muted">Not applicable</p>
              </section>
            );
          return (
            <section class={`section ${diff?.addedSectionKeys.has(s.key) ? "hl-added" : ""}`}>
              <h2>
                {s.prompt}
                {s.origin === "custom" && <span class="badge">extra</span>}
              </h2>
              {s.items.length === 0 && removed.length === 0 && <p class="small muted">Not filled in yet</p>}
              <ul class="answers">
                {s.items.map((i) => (
                  <li class={itemClass(i, diff)}>
                    <RichText text={i.text} detect={review ? undefined : { selfId: card.id, onLink: linkMention(i) }} />
                    <Refs refs={i.refs} />
                  </li>
                ))}
                {removed.map((r) => (
                  <li class="hl-removed">
                    <RichText text={r.item.text} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {card.references.length > 0 && (
          <section class="section">
            <h2>References</h2>
            <Refs refs={card.references} block />
          </section>
        )}

        {card.notes && (
          <section class="section">
            <h2>Notes</h2>
            <p class="notes">
              <RichText text={card.notes} />
            </p>
          </section>
        )}

        {backlinks.length > 0 && (
          <section class="section">
            <h2>Linked from</h2>
            <div class="chips-wrap">
              {backlinks.map((b) => (
                <button type="button" class="chip" onClick={() => openCard(b.id)}>
                  {b.title}
                </button>
              ))}
            </div>
          </section>
        )}
        <div class="bottom-spacer" />
      </div>

      {review && detail && !pending && (
        <div class="action-bar">
          <button type="button" class="btn primary block" onClick={back}>
            ✓ Reviewed — back to list
          </button>
        </div>
      )}
      {review && pending && (
        <div class="action-bar">
          <button
            type="button"
            class="btn"
            onClick={async () => {
              const ok = await confirmSheet(
                isNewCard ? "Remove this card the AI created?" : "Undo the AI's changes to this card?",
                isNewCard ? "Remove card" : "Undo changes",
                isNewCard
                  ? "If other cards link to it, it stays as an empty stub so their links keep working."
                  : "Other cards are not affected. You can still undo this from Changes.",
                true,
              );
              if (!ok) return;
              try {
                const res = await api<{ changeId: string | null }>(`/api/inbox/${id}/revert`, { body: {} });
                await refresh();
                back();
                if (res.changeId) toast("AI changes undone", { label: "Redo", run: () => undo(res.changeId!) });
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            Undo AI
          </button>
          <button type="button" class="btn" onClick={() => openOverlay({ kind: "edit", id })}>
            Edit
          </button>
          <button type="button" class="btn primary" onClick={() => markReviewed(id)}>
            ✓ Looks good
          </button>
        </div>
      )}
    </div>
  );
}

async function markReviewed(id: string) {
  await api(`/api/inbox/${id}/reviewed`, { body: {} });
  inboxCount.value = Math.max(0, inboxCount.value - 1);
  void refresh();
  back();
}

function itemClass(i: Item, diff: CardDiff | null) {
  if (!diff) return "";
  if (diff.addedItemIds.has(i.id)) return "hl-added";
  if (diff.changedItemIds.has(i.id)) return "hl-changed";
  return "";
}

export function Refs({ refs, block }: { refs?: Reference[]; block?: boolean }) {
  if (!refs?.length) return null;
  return (
    <div class={block ? "refs block" : "refs"}>
      {refs.map((r) => (
        <a class="ref" href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {/youtu\.?be|vimeo/.test(r.url) ? "▶ " : "↗ "}
          {r.label}
        </a>
      ))}
    </div>
  );
}

export { findMentions };
