// Navigation: four tabs, each with its own stack of views, plus full-screen overlays (card peek,
// editor) that sit on top of whatever tab is active. Every push adds a browser history entry so
// the phone's back gesture/button pops the top view instead of leaving the app.

import { computed, signal } from "@preact/signals";

export type Tab = "practice" | "browse" | "changes" | "settings";

export type View =
  | { kind: "home" }
  | { kind: "card"; id: string }
  | { kind: "review"; cardId: string }
  | { kind: "list"; list: "stubs" | "unfilled" };

export type Overlay =
  | { kind: "card"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "new"; type?: string; title?: string };

export const tab = signal<Tab>("practice");
export const stacks = signal<Record<Tab, View[]>>({
  practice: [{ kind: "home" }],
  browse: [{ kind: "home" }],
  changes: [{ kind: "home" }],
  settings: [{ kind: "home" }],
});
export const overlays = signal<Overlay[]>([]);

export const currentView = computed(() => {
  const s = stacks.value[tab.value];
  return s[s.length - 1];
});

let depth = 0;

function pushHistory() {
  depth++;
  history.pushState({ depth }, "");
}

export function switchTab(t: Tab) {
  if (tab.value === t) {
    // Tapping the active tab returns to its root.
    if (stacks.value[t].length > 1) stacks.value = { ...stacks.value, [t]: [stacks.value[t][0]] };
    return;
  }
  tab.value = t;
}

export function push(view: View) {
  const t = tab.value;
  stacks.value = { ...stacks.value, [t]: [...stacks.value[t], view] };
  pushHistory();
}

export function openOverlay(o: Overlay) {
  overlays.value = [...overlays.value, o];
  pushHistory();
}

/** Replace the top overlay (e.g. "new card" becomes "edit card" once created). */
export function replaceOverlay(o: Overlay) {
  overlays.value = [...overlays.value.slice(0, -1), o];
}

function popInternal(): boolean {
  if (overlays.value.length) {
    overlays.value = overlays.value.slice(0, -1);
    return true;
  }
  const t = tab.value;
  if (stacks.value[t].length > 1) {
    stacks.value = { ...stacks.value, [t]: stacks.value[t].slice(0, -1) };
    return true;
  }
  return false;
}

/** Go back one level (UI back buttons). */
export function back() {
  if (depth > 0) history.back();
  else popInternal();
}

/** Handlers that want to veto leaving (e.g. editor with unsaved changes). */
let guard: (() => boolean) | null = null;
export function setBackGuard(fn: (() => boolean) | null) {
  guard = fn;
}

window.addEventListener("popstate", () => {
  if (guard && !guard()) {
    // Stay: re-add the entry we just lost.
    history.pushState({ depth }, "");
    return;
  }
  depth = Math.max(0, depth - 1);
  popInternal();
});

/** Open a card from anywhere: inside practice it's an overlay so the session is kept. */
export function openCard(id: string) {
  if (overlays.value.length || tab.value === "practice") openOverlay({ kind: "card", id });
  else push({ kind: "card", id });
}
