import type { ComponentChildren } from "preact";
import { normalizeText, parseLinks } from "../../shared/cards";
import type { Card } from "../../shared/types";
import { openCard } from "../nav";
import { cards, cardsBySlug } from "../store";

interface Props {
  text: string;
  /** Offer "link?" on words that match an existing card's title/alias but aren't linked. */
  detect?: { selfId: string; onLink: (match: { from: number; to: number; card: Card }) => void };
}

/** Renders answer text with inline [[links]] as tappable chips. */
export function RichText({ text, detect }: Props) {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const t of parseLinks(text)) {
    if (t.start > last) parts.push(plain(text.slice(last, t.start), last, detect));
    const card = cardsBySlug.value.get(t.target);
    parts.push(
      <button
        type="button"
        class={`link ${!card || card.isStub ? "stub" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (card) openCard(card.id);
        }}
      >
        {t.label ?? card?.title ?? t.target}
      </button>,
    );
    last = t.end;
  }
  if (last < text.length) parts.push(plain(text.slice(last), last, detect));
  return <>{parts}</>;
}

function plain(segment: string, offset: number, detect: Props["detect"]) {
  if (!detect) return segment;
  const matches = findMentions(segment, detect.selfId);
  if (!matches.length) return segment;
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of matches) {
    out.push(segment.slice(last, m.from));
    out.push(
      <button
        type="button"
        class="mention"
        title={`Link to ${m.card.title}?`}
        onClick={(e) => {
          e.stopPropagation();
          detect.onLink({ from: offset + m.from, to: offset + m.to, card: m.card });
        }}
      >
        {segment.slice(m.from, m.to)}
      </button>,
    );
    last = m.to;
  }
  out.push(segment.slice(last));
  return <>{out}</>;
}

/** Whole-word occurrences of other cards' titles/aliases (longest first, non-overlapping). */
export function findMentions(segment: string, selfId: string) {
  const names: { name: string; card: Card }[] = [];
  for (const c of cards.value) {
    if (c.id === selfId) continue;
    for (const n of [c.title, ...c.aliases]) if (n.trim().length >= 3) names.push({ name: n, card: c });
  }
  names.sort((a, b) => b.name.length - a.name.length);
  const lower = segment.toLowerCase();
  const taken: boolean[] = [];
  const found: { from: number; to: number; card: Card }[] = [];
  for (const { name, card } of names) {
    const needle = name.toLowerCase();
    let i = lower.indexOf(needle);
    while (i >= 0) {
      const end = i + needle.length;
      // Allow a plural "s" after the name, as in "[[Wedding]]s".
      const endWithS = lower[end] === "s" ? end + 1 : end;
      const before = i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]);
      const after = endWithS >= lower.length || !/[\p{L}\p{N}]/u.test(lower[endWithS]);
      const free = !taken.slice(i, endWithS).some(Boolean);
      if (before && after && free && normalizeText(segment.slice(i, end)) === normalizeText(name)) {
        found.push({ from: i, to: endWithS, card });
        for (let k = i; k < endWithS; k++) taken[k] = true;
      }
      i = lower.indexOf(needle, end);
    }
  }
  return found.sort((a, b) => a.from - b.from);
}
