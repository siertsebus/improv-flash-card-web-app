import { useEffect, useState } from "preact/hooks";
import { TEMPLATES } from "../../shared/templates";
import type { Settings as SettingsT } from "../../shared/types";
import { api, loggedOut, tzParam } from "../api";
import { toast } from "../components/ui";
import { cards, settings } from "../store";

export function Settings() {
  const s = settings.value;
  const [stats, setStats] = useState<{ streak: number; perDay: Record<string, number> } | null>(null);

  useEffect(() => {
    api(`/api/stats?${tzParam()}`).then(setStats).catch(() => {});
  }, []);

  async function save(patch: Partial<SettingsT>) {
    try {
      settings.value = await api<SettingsT>("/api/settings", { method: "PUT", body: patch });
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const last14 = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000 - new Date().getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    return { d, n: stats?.perDay[d] ?? 0 };
  });
  const max = Math.max(1, ...last14.map((x) => x.n));

  return (
    <div class="screen">
      <header class="topbar">
        <div class="topbar-title">Settings</div>
      </header>
      <div class="scroll pad">
        <section class="section">
          <h2>Daily practice</h2>
          {s && (
            <>
              <Stepper
                label="New questions per day"
                value={s.newPerDay}
                step={5}
                min={0}
                max={200}
                onChange={(v) => save({ newPerDay: v })}
              />
              <Stepper
                label="Max reviews per day"
                value={s.maxReviewsPerDay}
                step={25}
                min={10}
                max={2000}
                onChange={(v) => save({ maxReviewsPerDay: v })}
              />
            </>
          )}
        </section>

        <section class="section">
          <h2>Stats</h2>
          <div class="stats-row">
            <div class="stat">
              <strong>{stats?.streak ?? "–"}</strong>
              <span>day streak</span>
            </div>
            <div class="stat">
              <strong>{stats?.perDay[today] ?? 0}</strong>
              <span>today</span>
            </div>
            <div class="stat">
              <strong>{cards.value.filter((c) => !c.isStub).length}</strong>
              <span>cards</span>
            </div>
          </div>
          <div class="bars" aria-label="Reviews in the last 14 days">
            {last14.map((x) => (
              <div class="bar" title={`${x.d}: ${x.n}`} style={{ height: `${(x.n / max) * 100}%` }} />
            ))}
          </div>
          <p class="small muted">Reviews per day, last 14 days</p>
          <ul class="type-counts">
            {TEMPLATES.map((t) => (
              <li>
                <span>{t.label}</span>
                <strong>{cards.value.filter((c) => c.type === t.key && !c.isStub).length}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section class="section">
          <h2>Connect an AI assistant</h2>
          <p class="small">
            MCP connector URL (e.g. Claude → Settings → Connectors → Add custom connector):
          </p>
          <code class="code">{location.origin}/mcp/&lt;your MCP secret&gt;</code>
          <p class="small muted">
            For assistants without MCP, a REST API is described at <code>{location.origin}/api/openapi.json</code>{" "}
            (Bearer token = your API token).
          </p>
        </section>

        <button
          type="button"
          class="btn ghost block"
          onClick={async () => {
            await api("/api/logout", { body: {} });
            loggedOut.value = true;
          }}
        >
          Log out
        </button>
        <div class="bottom-spacer" />
      </div>
    </div>
  );
}

function Stepper(props: { label: string; value: number; step: number; min: number; max: number; onChange: (v: number) => void }) {
  const set = (v: number) => props.onChange(Math.max(props.min, Math.min(props.max, v)));
  return (
    <div class="stepper">
      <span>{props.label}</span>
      <div class="stepper-controls">
        <button type="button" class="icon-btn" aria-label="Less" onClick={() => set(props.value - props.step)}>
          −
        </button>
        <strong>{props.value}</strong>
        <button type="button" class="icon-btn" aria-label="More" onClick={() => set(props.value + props.step)}>
          +
        </button>
      </div>
    </div>
  );
}
