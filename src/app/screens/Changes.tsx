import { useEffect, useState } from "preact/hooks";
import type { ChangeEntry } from "../../shared/types";
import { undo } from "../actions";
import { api } from "../api";
import { timeAgo, toast } from "../components/ui";
import { push } from "../nav";
import { cardsById, dataVersion } from "../store";

interface Group {
  batchId: string;
  source: ChangeEntry["source"];
  createdAt: string;
  undone: boolean;
  entries: ChangeEntry[];
}

export function Changes() {
  const [groups, setGroups] = useState<Group[] | null>(null);

  useEffect(() => {
    api<ChangeEntry[]>("/api/changes?limit=100")
      .then((list) => {
        const byBatch = new Map<string, Group>();
        for (const e of list) {
          const g = byBatch.get(e.batchId) ?? {
            batchId: e.batchId,
            source: e.source,
            createdAt: e.createdAt,
            undone: !!e.undoneAt,
            entries: [],
          };
          g.entries.push(e);
          byBatch.set(e.batchId, g);
        }
        setGroups([...byBatch.values()]);
      })
      .catch((e) => toast(e.message));
  }, [dataVersion.value]);

  return (
    <div class="screen">
      <header class="topbar">
        <div class="topbar-title">Changes</div>
      </header>
      <div class="scroll">
        {groups?.length === 0 && <p class="empty">No changes yet.</p>}
        <div class="list">
          {groups?.map((g) => (
            <div class={`list-row change ${g.undone ? "undone" : ""}`}>
              <div class="list-main">
                <span class={`badge ${g.source === "ai" ? "ai" : ""}`}>{g.source === "ai" ? "AI" : "You"}</span>
                <span class="small muted">{timeAgo(g.createdAt)}</span>
                {g.undone ? (
                  <span class="small muted push-right">undone</span>
                ) : (
                  <button type="button" class="btn ghost small push-right" onClick={() => undo(g.batchId)}>
                    Undo
                  </button>
                )}
              </div>
              {g.entries.map((e) => (
                <button
                  type="button"
                  class="change-line"
                  disabled={!cardsById.value.has(e.cardId)}
                  onClick={() => push({ kind: "card", id: e.cardId })}
                >
                  <strong>{e.cardTitle}</strong> <span class="muted">{e.summary}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div class="bottom-spacer" />
      </div>
    </div>
  );
}
