import { useEffect, useRef, useState } from "preact/hooks";
import { newId, normalizeContent } from "../../shared/cards";
import { TEMPLATE_BY_KEY, TEMPLATES, typeLabel } from "../../shared/templates";
import type { Card, Item, Reference, Section } from "../../shared/types";
import { saveCard } from "../actions";
import { api } from "../api";
import { LinkInput } from "../components/LinkInput";
import { choose, confirmSheet, toast, TopBar } from "../components/ui";
import { back, replaceOverlay, setBackGuard } from "../nav";
import { cardsById, refresh, suggestCards } from "../store";

// ---------- new card ----------

export function NewCard({ type: initialType, title: initialTitle }: { type?: string; title?: string }) {
  const [type, setType] = useState(initialType ?? "");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [busy, setBusy] = useState(false);
  const existing = title.trim() ? suggestCards(title, undefined, 3) : [];

  async function create() {
    if (!type || !title.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ card: Card }>("/api/cards", { body: { type, title: title.trim() } });
      await refresh();
      replaceOverlay({ kind: "edit", id: res.card.id });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="screen">
      <TopBar title="New card" />
      <div class="scroll pad">
        <label class="field">
          <span>Title</span>
          <input
            value={title}
            placeholder="e.g. Pirate captain"
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            autoFocus
          />
        </label>
        {existing.some((s) => s.score >= 60) && (
          <p class="small muted">
            Similar: {existing.map((s) => s.card.title + (s.card.isStub ? " (stub)" : "")).join(", ")}. A stub with
            the same title will be filled in.
          </p>
        )}
        <div class="field">
          <span>Type</span>
          <div class="type-grid">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                class={`type-option ${type === t.key ? "selected" : ""}`}
                onClick={() => setType(t.key)}
              >
                <strong>{t.label}</strong>
                <small>{t.examples.slice(0, 3).join(", ")}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div class="action-bar">
        <button type="button" class="btn primary block" disabled={!type || !title.trim() || busy} onClick={create}>
          Create and fill in
        </button>
      </div>
    </div>
  );
}

// ---------- editor ----------

export function Editor({ id }: { id: string }) {
  const original = cardsById.value.get(id);
  const [draft, setDraft] = useState<Card | null>(() => (original ? structuredClone(original) : null));
  const [saving, setSaving] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState<Record<string, string>>({});
  const [mergeQuery, setMergeQuery] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  const dirty =
    !!draft && !!original && JSON.stringify(withPending(draft, newItemText)) !== JSON.stringify(original);
  dirtyRef.current = dirty;

  useEffect(() => {
    setBackGuard(() => {
      if (!dirtyRef.current) return true;
      void confirmSheet("Discard your changes?", "Discard", undefined, true).then((ok) => {
        if (ok) {
          dirtyRef.current = false;
          setBackGuard(null);
          back();
        }
      });
      return false;
    });
    return () => setBackGuard(null);
  }, []);

  if (!draft || !original)
    return (
      <div class="screen">
        <TopBar title="Edit" />
        <p class="empty">Card not found.</p>
      </div>
    );

  const update = (fn: (c: Card) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
  };
  const section = (c: Card, key: string) => c.sections.find((s) => s.key === key)!;
  const findItem = (c: Card, itemId: string) => {
    for (const s of c.sections) {
      const idx = s.items.findIndex((i) => i.id === itemId);
      if (idx >= 0) return { s, idx };
    }
    throw new Error("item not found");
  };

  async function save() {
    setSaving(true);
    const saved = await saveCard(withPending(draft!, newItemText));
    setSaving(false);
    if (saved) {
      dirtyRef.current = false;
      setBackGuard(null);
      back();
    }
  }

  function addItem(key: string) {
    const text = (newItemText[key] ?? "").trim();
    if (!text) return;
    update((c) => section(c, key).items.push({ id: newId(), text }));
    setNewItemText({ ...newItemText, [key]: "" });
  }

  function itemMenu(s: Section, item: Item, index: number) {
    const others = draft!.sections.filter((x) => x.key !== s.key);
    choose({
      title: "Answer",
      options: [
        ...(index > 0
          ? [{ label: "↑ Move up", run: () => update((c) => move(section(c, s.key).items, index, index - 1)) }]
          : []),
        ...(index < s.items.length - 1
          ? [{ label: "↓ Move down", run: () => update((c) => move(section(c, s.key).items, index, index + 1)) }]
          : []),
        ...(others.length
          ? [
              {
                label: "Move to another question…",
                run: () =>
                  choose({
                    title: "Move to",
                    options: others.map((o) => ({
                      label: o.prompt,
                      run: () =>
                        update((c) => {
                          const { s: from, idx } = findItem(c, item.id);
                          const [it] = from.items.splice(idx, 1);
                          section(c, o.key).items.push(it);
                        }),
                    })),
                  }),
              },
            ]
          : []),
        { label: "Attach reference link", run: () => setOpenItem(item.id) },
        {
          label: "Delete answer",
          danger: true,
          run: () => update((c) => section(c, s.key).items.splice(index, 1)),
        },
      ],
    });
  }

  function sectionMenu(s: Section) {
    choose({
      title: s.prompt,
      options: [
        s.status === "open"
          ? {
              label: "Mark as not applicable",
              run: () => update((c) => (section(c, s.key).status = "not_applicable")),
            }
          : { label: "Mark as applicable again", run: () => update((c) => (section(c, s.key).status = "open")) },
        ...(s.origin === "custom"
          ? [
              {
                label: "Remove this extra question",
                danger: true,
                run: () => update((c) => (c.sections = c.sections.filter((x) => x.key !== s.key))),
              },
            ]
          : []),
      ],
    });
  }

  function changeType(type: string) {
    update((c) => {
      c.type = type;
      Object.assign(c, normalizeContent(type, c));
    });
  }

  async function deleteCard() {
    const ok = await confirmSheet(
      `Delete “${original!.title}”?`,
      "Delete card",
      "Links to it in other cards become plain text. You can undo this from Changes.",
      true,
    );
    if (!ok) return;
    try {
      await api(`/api/cards/${id}`, { method: "DELETE" });
      dirtyRef.current = false;
      setBackGuard(null);
      await refresh();
      back();
      // Also leave the (now missing) card page underneath if there is one.
      setTimeout(back, 50);
      toast("Deleted");
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function mergeInto(target: Card) {
    const ok = await confirmSheet(
      `Merge into “${target.title}”?`,
      "Merge",
      `All answers of “${original!.title}” move to “${target.title}”, links are redirected and this card is removed.`,
    );
    if (!ok) return;
    try {
      await api(`/api/cards/${id}/merge`, { body: { into: target.id } });
      dirtyRef.current = false;
      setBackGuard(null);
      await refresh();
      back();
      toast(`Merged into ${target.title}`);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const template = TEMPLATE_BY_KEY[draft.type];

  return (
    <div class="screen editor">
      <TopBar
        title="Edit card"
        actions={
          <button type="button" class="btn primary small" disabled={saving || !dirty} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        }
      />
      <div class="scroll pad">
        <label class="field">
          <span>Title</span>
          <input value={draft.title} onInput={(e) => update((c) => (c.title = (e.target as HTMLInputElement).value))} />
        </label>
        <label class="field">
          <span>Type</span>
          <select value={draft.type} onChange={(e) => changeType((e.target as HTMLSelectElement).value)}>
            {TEMPLATES.map((t) => (
              <option value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>

        {draft.sections.map((s) => {
          const hint = template?.questions.find((q) => q.key === s.key)?.linkHint;
          return (
            <section class={`section edit-section ${s.status === "not_applicable" ? "na" : ""}`}>
              <div class="section-head">
                <h2>
                  {s.prompt}
                  {s.origin === "custom" && <span class="badge">extra</span>}
                </h2>
                <button type="button" class="icon-btn" aria-label="Question options" onClick={() => sectionMenu(s)}>
                  ⋯
                </button>
              </div>
              {s.status === "not_applicable" ? (
                <p class="small muted">Not applicable — skipped in practice.</p>
              ) : (
                <>
                  {s.items.map((item, index) => (
                    <div class="edit-item">
                      <div class="edit-item-row">
                        <LinkInput
                          value={item.text}
                          preferType={hint}
                          selfId={draft.id}
                          onInput={(v) => update((c) => (findItemIn(c, item.id).text = v))}
                        />
                        <button
                          type="button"
                          class="icon-btn"
                          aria-label="Answer options"
                          onClick={() => itemMenu(s, item, index)}
                        >
                          ⋯
                        </button>
                      </div>
                      {(openItem === item.id || (item.refs?.length ?? 0) > 0) && (
                        <RefsEditor
                          refs={item.refs ?? []}
                          autoAdd={openItem === item.id && !(item.refs?.length ?? 0)}
                          onChange={(refs) =>
                            update((c) => {
                              findItemIn(c, item.id).refs = refs;
                            })
                          }
                        />
                      )}
                    </div>
                  ))}
                  <div class="edit-item add">
                    <LinkInput
                      value={newItemText[s.key] ?? ""}
                      placeholder="Add an answer…"
                      preferType={hint}
                      selfId={draft.id}
                      onInput={(v) => setNewItemText({ ...newItemText, [s.key]: v })}
                      onEnter={() => addItem(s.key)}
                    />
                    {(newItemText[s.key] ?? "").trim() && (
                      <button type="button" class="btn small" onClick={() => addItem(s.key)}>
                        Add
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          );
        })}

        {newQuestion === null ? (
          <button type="button" class="btn ghost block" onClick={() => setNewQuestion("")}>
            + Extra question for this card
          </button>
        ) : (
          <div class="section">
            <label class="field">
              <span>Extra question (only on this card)</span>
              <input
                value={newQuestion}
                autoFocus
                placeholder="e.g. What do they eat?"
                onInput={(e) => setNewQuestion((e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="row">
              <button type="button" class="btn" onClick={() => setNewQuestion(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn primary"
                disabled={!newQuestion.trim()}
                onClick={() => {
                  update((c) =>
                    c.sections.push({
                      key: `q-${newId(6)}`,
                      prompt: newQuestion.trim(),
                      origin: "custom",
                      status: "open",
                      items: [],
                    }),
                  );
                  setNewQuestion(null);
                }}
              >
                Add question
              </button>
            </div>
          </div>
        )}

        <section class="section">
          <h2>References</h2>
          <p class="small muted">Videos, articles, images. Shown after revealing an answer, never quizzed.</p>
          <RefsEditor refs={draft.references} onChange={(refs) => update((c) => (c.references = refs))} />
        </section>

        <section class="section">
          <h2>Notes</h2>
          <LinkInput
            multiline
            value={draft.notes}
            placeholder="Anything else (not quizzed)"
            selfId={draft.id}
            onInput={(v) => update((c) => (c.notes = v))}
          />
        </section>

        <section class="section">
          <h2>Details</h2>
          <label class="field">
            <span>One-line summary</span>
            <input value={draft.summary} onInput={(e) => update((c) => (c.summary = (e.target as HTMLInputElement).value))} />
          </label>
          <ListField label="Also known as" value={draft.aliases} onChange={(v) => update((c) => (c.aliases = v))} />
          <ListField label="Tags" value={draft.tags} onChange={(v) => update((c) => (c.tags = v))} />
        </section>

        <section class="section danger-zone">
          {mergeQuery === null ? (
            <button type="button" class="btn ghost block" onClick={() => setMergeQuery("")}>
              Merge into another card…
            </button>
          ) : (
            <div>
              <label class="field">
                <span>Merge “{original.title}” into…</span>
                <input
                  value={mergeQuery}
                  autoFocus
                  placeholder="Search a card"
                  onInput={(e) => setMergeQuery((e.target as HTMLInputElement).value)}
                />
              </label>
              <div class="chips-wrap">
                {suggestCards(mergeQuery, original.type, 8, original.id).map((s) => (
                  <button type="button" class="chip" onClick={() => mergeInto(s.card)}>
                    {s.card.title} <small>· {typeLabel(s.card.type)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button type="button" class="btn danger block" onClick={deleteCard}>
            Delete card
          </button>
        </section>
        <div class="bottom-spacer" />
      </div>
    </div>
  );
}

/** Include answers typed in the "add" fields but not yet confirmed, so Save never loses them. */
function withPending(card: Card, pending: Record<string, string>): Card {
  if (!Object.values(pending).some((v) => v.trim())) return card;
  const c = structuredClone(card);
  for (const s of c.sections) {
    const text = pending[s.key]?.trim();
    if (text) s.items.push({ id: `pending-${s.key}`, text });
  }
  return c;
}

function findItemIn(c: Card, itemId: string): Item {
  for (const s of c.sections) for (const i of s.items) if (i.id === itemId) return i;
  throw new Error("item not found");
}

function move<T>(list: T[], from: number, to: number) {
  const [x] = list.splice(from, 1);
  list.splice(to, 0, x);
}

function ListField(props: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(props.value.join(", "));
  return (
    <label class="field">
      <span>{props.label} (comma separated)</span>
      <input
        value={text}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setText(v);
          props.onChange(
            v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}

function RefsEditor(props: { refs: Reference[]; onChange: (refs: Reference[]) => void; autoAdd?: boolean }) {
  useEffect(() => {
    if (props.autoAdd) props.onChange([...props.refs, { id: newId(), label: "", url: "" }]);
  }, []);
  const set = (i: number, patch: Partial<Reference>) =>
    props.onChange(props.refs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div class="refs-editor">
      {props.refs.map((r, i) => (
        <div class="ref-row">
          <input
            value={r.label}
            placeholder="Label (e.g. Irish accent example)"
            onInput={(e) => set(i, { label: (e.target as HTMLInputElement).value })}
          />
          <input
            value={r.url}
            type="url"
            inputMode="url"
            placeholder="https://…"
            onInput={(e) => set(i, { url: (e.target as HTMLInputElement).value })}
          />
          <button
            type="button"
            class="icon-btn"
            aria-label="Remove reference"
            onClick={() => props.onChange(props.refs.filter((_, k) => k !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        class="btn ghost small"
        onClick={() => props.onChange([...props.refs, { id: newId(), label: "", url: "" }])}
      >
        + Add reference link
      </button>
    </div>
  );
}
