import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { back } from "../nav";

export function TopBar(props: { title?: ComponentChildren; onBack?: (() => void) | false; actions?: ComponentChildren }) {
  return (
    <header class="topbar">
      {props.onBack !== false && (
        <button type="button" class="icon-btn" aria-label="Back" onClick={props.onBack ?? back}>
          ←
        </button>
      )}
      <div class="topbar-title">{props.title}</div>
      <div class="topbar-actions">{props.actions}</div>
    </header>
  );
}

// ---------- toasts (with optional action, e.g. Undo) ----------

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, action?: Toast["action"], ms = 4000) {
  const t = { id: ++toastId, text, action };
  toasts.value = [...toasts.value, t];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== t.id)), ms);
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div class="toast" key={t.id}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                toasts.value = toasts.value.filter((x) => x.id !== t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- bottom sheet for simple choices (no nested scrolling) ----------

interface SheetState {
  title: string;
  message?: string;
  options: { label: string; danger?: boolean; run: () => void }[];
}
export const sheet = signal<SheetState | null>(null);

export function choose(s: SheetState) {
  sheet.value = s;
}

export function confirmSheet(title: string, confirmLabel: string, message?: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    sheet.value = {
      title,
      message,
      options: [
        { label: confirmLabel, danger, run: () => resolve(true) },
        { label: "Cancel", run: () => resolve(false) },
      ],
    };
  });
}

export function Sheet() {
  const s = sheet.value;
  if (!s) return null;
  return (
    <div class="sheet-backdrop" onClick={() => (sheet.value = null)}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-title">{s.title}</div>
        {s.message && <p class="muted">{s.message}</p>}
        {s.options.map((o) => (
          <button
            type="button"
            class={`btn block ${o.danger ? "danger" : ""}`}
            onClick={() => {
              sheet.value = null;
              o.run();
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}
