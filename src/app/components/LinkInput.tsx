import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { normalizeText } from "../../shared/cards";
import { typeLabel } from "../../shared/templates";
import { suggestCards, type Suggestion } from "../store";

interface Props {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  /** Card type to rank first (the question's link hint). */
  preferType?: string;
  selfId?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  multiline?: boolean;
  class?: string;
}

interface Candidate {
  from: number;
  to: number;
  phrase: string;
  bracket: boolean;
}

/** Find what's being typed at the caret: an open "[[..." or the last 1–3 words. */
function candidatesAt(text: string, caret: number): Candidate[] {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open >= 0 && open > before.lastIndexOf("]]")) {
    const closeAfter = text.slice(caret).startsWith("]]") ? 2 : 0;
    return [{ from: open, to: caret + closeAfter, phrase: before.slice(open + 2), bracket: true }];
  }
  // Inside a finished link? No suggestions.
  if (/[\p{L}\p{N}]/u.test(text[caret] ?? "")) return [];
  const m = before.match(/((?:[\p{L}\p{N}'’-]+\s+){0,2}[\p{L}\p{N}'’-]+)$/u);
  if (!m) return [];
  const words = m[1].split(/\s+/);
  const out: Candidate[] = [];
  for (let n = words.length; n >= 1; n--) {
    const phrase = words.slice(-n).join(" ");
    if (normalizeText(phrase).length < 2) continue;
    out.push({ from: caret - phrase.length, to: caret, phrase, bracket: false });
  }
  return out;
}

export function LinkInput(props: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);

  useLayoutEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, []);

  const update = () => setCaret(ref.current?.selectionStart ?? 0);

  let chips: { label: string; sub?: string; apply: () => void; isNew?: boolean }[] = [];
  if (focused) {
    const seen = new Set<string>();
    const cands = candidatesAt(props.value, caret);
    let best: Candidate | undefined;
    for (const c of cands) {
      const sugg: Suggestion[] = c.bracket
        ? suggestCards(c.phrase || "", props.preferType, 6, props.selfId)
        : suggestCards(c.phrase, props.preferType, 6, props.selfId).filter((s) => s.score >= 40);
      for (const s of sugg) {
        if (seen.has(s.card.id)) continue;
        seen.add(s.card.id);
        best ??= c;
        chips.push({
          label: s.card.title,
          sub: typeLabel(s.card.type),
          apply: () => insert(c, linkFor(c, s.card.slug, s.card.title, s.card.aliases)),
        });
      }
    }
    chips = chips.slice(0, 6);
    const newCand = cands[0]?.bracket ? cands[0] : cands[cands.length - 1];
    if (newCand && normalizeText(newCand.phrase).length >= 3) {
      const title = capitalize(newCand.phrase.trim());
      const exists = suggestCards(title, undefined, 1, props.selfId)[0]?.score >= 100;
      // Only after "[[" (or the link button): offering it for every typed word would be noise.
      if (!exists && newCand.bracket)
        chips.push({
          label: `+ New card “${title}”`,
          isNew: true,
          apply: () => insert(newCand, `[[${title}]]`),
        });
    }
  }

  function startLink() {
    const el = ref.current;
    const start = el?.selectionStart ?? props.value.length;
    const end = el?.selectionEnd ?? start;
    const selected = props.value.slice(start, end);
    const text = props.value.slice(0, start) + "[[" + selected + props.value.slice(end);
    props.onInput(text);
    const pos = start + 2 + selected.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  function insert(c: Candidate, replacement: string) {
    const text = props.value.slice(0, c.from) + replacement + props.value.slice(c.to);
    props.onInput(text);
    const pos = c.from + replacement.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  return (
    <div class={`link-input ${props.class ?? ""}`}>
      {chips.length > 0 && (
        <div class="suggest-bar" onPointerDown={(e) => e.preventDefault()}>
          {chips.map((c) => (
            <button type="button" class={`chip ${c.isNew ? "chip-new" : ""}`} onClick={c.apply}>
              {c.label}
              {c.sub && <small> · {c.sub}</small>}
            </button>
          ))}
        </div>
      )}
      <div class="link-input-row">
      <textarea
        ref={ref}
        rows={1}
        value={props.value}
        placeholder={props.placeholder}
        enterkeyhint={props.multiline ? "enter" : "done"}
        onInput={(e) => {
          props.onInput((e.target as HTMLTextAreaElement).value);
          update();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !props.multiline) {
            e.preventDefault();
            props.onEnter?.();
          }
        }}
        onKeyUp={update}
        onClick={update}
        onFocus={() => {
          setFocused(true);
          update();
        }}
        onBlur={() => setFocused(false)}
      />
      {focused && (
        <button
          type="button"
          class="icon-btn link-btn"
          aria-label="Insert link"
          onPointerDown={(e) => e.preventDefault()}
          onClick={startLink}
        >
          [[ ]]
        </button>
      )}
      </div>
    </div>
  );
}

function linkFor(c: Candidate, slug: string, title: string, aliases: string[]): string {
  const phrase = c.phrase.trim();
  if (c.bracket || !phrase) return `[[${slug}]]`;
  const p = normalizeText(phrase);
  // Completing a partly typed title ("chu" → Church) shows the title; a different word that
  // matches an alias or the start of the title keeps the user's wording as the shown text.
  if (normalizeText(title).startsWith(p) && p.length < normalizeText(title).length) return `[[${slug}]]`;
  if (p === normalizeText(title)) return phrase === title ? `[[${slug}]]` : `[[${slug}|${phrase}]]`;
  if (aliases.some((a) => normalizeText(a) === p)) return `[[${slug}|${phrase}]]`;
  return `[[${slug}]]`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
