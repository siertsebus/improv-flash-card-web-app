import { useState } from "preact/hooks";
import { api, loggedOut } from "./api";
import { Sheet, Toasts } from "./components/ui";
import { overlays, stacks, switchTab, tab, type Tab, type View } from "./nav";
import { BrowseHome, SpecialList } from "./screens/Browse";
import { CardView } from "./screens/CardView";
import { Changes } from "./screens/Changes";
import { Editor, NewCard } from "./screens/Editor";
import { Practice } from "./screens/Practice";
import { Settings } from "./screens/Settings";
import { inboxCount, loaded, refresh } from "./store";

const ROOTS: Record<Tab, () => preact.JSX.Element | null> = {
  practice: Practice,
  browse: BrowseHome,
  changes: Changes,
  settings: Settings,
};

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "practice", label: "Practice", icon: "◉" },
  { key: "browse", label: "Browse", icon: "☰" },
  { key: "changes", label: "Changes", icon: "↺" },
  { key: "settings", label: "Settings", icon: "⚙" },
];

function renderView(v: View) {
  switch (v.kind) {
    case "card":
      return <CardView key={v.id} id={v.id} />;
    case "review":
      return <CardView key={`r-${v.cardId}`} id={v.cardId} review />;
    case "list":
      return <SpecialList list={v.list} />;
    default:
      return null;
  }
}

export function App() {
  if (loggedOut.value) return <Login />;
  if (!loaded.value) return <div class="splash">Loading…</div>;

  return (
    <div class="app">
      <main class="tabs">
        {TABS.map(({ key }) => {
          const stack = stacks.value[key];
          const Root = ROOTS[key];
          const top = stack[stack.length - 1];
          return (
            <div class="tab-pane" hidden={tab.value !== key}>
              <div class="view" hidden={stack.length > 1}>
                <Root />
              </div>
              {stack.length > 1 && <div class="view">{renderView(top)}</div>}
            </div>
          );
        })}
      </main>

      {overlays.value.map((o, i) => (
        <div class="overlay" style={{ zIndex: 20 + i }} key={i}>
          {o.kind === "card" && <CardView key={o.id} id={o.id} />}
          {o.kind === "edit" && <Editor key={o.id} id={o.id} />}
          {o.kind === "new" && <NewCard type={o.type} title={o.title} />}
        </div>
      ))}

      <nav class="tabbar">
        {TABS.map((t) => (
          <button type="button" class={`tab ${tab.value === t.key ? "active" : ""}`} onClick={() => switchTab(t.key)}>
            <span class="tab-icon">
              {t.icon}
              {t.key === "browse" && inboxCount.value > 0 && <span class="tab-dot">{inboxCount.value}</span>}
            </span>
            <span class="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <Sheet />
      <Toasts />
    </div>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { body: { password } });
      loggedOut.value = false;
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="login" onSubmit={submit}>
      <h1>Improv Cards</h1>
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
      />
      {error && <p class="error">{error}</p>}
      <button type="submit" class="btn primary block big" disabled={busy || !password}>
        Log in
      </button>
    </form>
  );
}
