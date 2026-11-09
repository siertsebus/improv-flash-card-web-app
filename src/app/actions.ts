import type { Card } from "../shared/types";
import { api, ApiError } from "./api";
import { confirmSheet, toast } from "./components/ui";
import { refresh, upsertCard } from "./store";

/** Save a whole card from the app. Returns the saved card, or null if it failed. */
export async function saveCard(card: Card): Promise<Card | null> {
  try {
    const res = await api<{ card: Card; changeId: string | null }>(`/api/cards/${card.id}`, {
      method: "PUT",
      body: card,
    });
    upsertCard(res.card);
    // Links may have created stubs or renamed slugs in other cards.
    void refresh();
    if (res.changeId) toast("Saved", { label: "Undo", run: () => undo(res.changeId!) });
    return res.card;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.details?.current) {
      toast("This card changed elsewhere (maybe by the AI). Reloaded the latest version.");
      await refresh();
    } else toast((e as Error).message);
    return null;
  }
}

export async function undo(batchId: string, force = false): Promise<boolean> {
  try {
    await api(`/api/changes/${batchId}/undo`, { body: { force } });
    await refresh();
    toast("Undone");
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.details?.needsForce) {
      const ok = await confirmSheet("Undo anyway?", "Undo, including later edits", e.message, true);
      return ok ? undo(batchId, true) : false;
    }
    toast((e as Error).message);
    return false;
  }
}
