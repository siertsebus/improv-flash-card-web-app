import { Hono, type Context } from "hono";
import { TEMPLATES } from "../shared/templates";
import type { ChangeSource } from "../shared/types";
import { handleMcp } from "./ai/mcp";
import { openApiSpec } from "./ai/openapi";
import { TOOL_BY_NAME } from "./ai/tools";
import { clearSessionCookie, hasValidSession, makeSessionCookie, safeEqual } from "./auth";
import { buildQueue, getSettings, recordReview, saveSettings, stats } from "./core/practice";
import { CardService, UserError } from "./core/service";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  MCP_SECRET: string;
  API_TOKEN: string;
}

type Vars = { source: ChangeSource };
type C = Context<{ Bindings: Env; Variables: Vars }>;

// Single user for now; every row is scoped by owner so this can grow into accounts later.
const OWNER = "me";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  if (err instanceof UserError) return c.json({ error: err.message, details: err.details }, err.status as 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// ---------- MCP (secret in the path, for clients that only accept a URL) ----------

app.all("/mcp/:secret", async (c) => {
  if (!safeEqual(c.req.param("secret"), c.env.MCP_SECRET)) return c.text("Not found", 404);
  return handleMcp(c.req.raw, c.env.DB, OWNER);
});

// ---------- auth ----------

app.post("/api/login", async (c) => {
  const { password } = await c.req.json<{ password?: string }>();
  if (!c.env.APP_PASSWORD || !c.env.SESSION_SECRET)
    return c.json({ error: "Server not set up: the APP_PASSWORD or SESSION_SECRET secret is missing." }, 500);
  if (!safeEqual(password ?? "", c.env.APP_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 800));
    return c.json({ error: "Wrong password" }, 401);
  }
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", await makeSessionCookie(c.env.SESSION_SECRET, secure));
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

app.get("/api/openapi.json", (c) => c.json(openApiSpec(new URL(c.req.url).origin)));

app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), c.env.API_TOKEN)) {
    c.set("source", "ai");
    return next();
  }
  if (await hasValidSession(c.req.header("Cookie"), c.env.SESSION_SECRET)) {
    c.set("source", "app");
    return next();
  }
  return c.json({ error: "Not logged in" }, 401);
});

const svc = (c: C) => new CardService(c.env.DB, OWNER, c.get("source"));
const tz = (c: C) => Number(c.req.query("tz") ?? 0) || 0;

// ---------- tools over REST (for AI services without MCP) ----------

app.post("/api/tools/:name", async (c) => {
  const tool = TOOL_BY_NAME.get(c.req.param("name"));
  if (!tool) return c.json({ error: "Unknown tool" }, 404);
  const parsed = tool.input.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  return c.json(await tool.run(svc(c), parsed.data));
});

// ---------- app API ----------

app.get("/api/bootstrap", async (c) => {
  const s = svc(c);
  const [cards, settings, inbox] = await Promise.all([s.all(), getSettings(c.env.DB, OWNER), s.inbox()]);
  return c.json({ cards, templates: TEMPLATES, settings, inboxCount: inbox.length });
});

app.get("/api/cards", async (c) => c.json(await svc(c).all()));

app.get("/api/cards/:ref", async (c) => c.json(await svc(c).describeCard(c.req.param("ref"))));

app.post("/api/cards", async (c) => {
  const body = await c.req.json<{ type: string; title: string }>();
  const { card, changeId } = await svc(c).createBlankCard(body.type, body.title);
  return c.json({ card: await svc(c).byId(card.id), changeId });
});

app.put("/api/cards/:id", async (c) => {
  const body = await c.req.json<{ version: number; title: string; type: string; slug?: string }>();
  return c.json(await svc(c).saveCard(c.req.param("id"), body.version, body));
});

app.delete("/api/cards/:id", async (c) => c.json(await svc(c).deleteCard(c.req.param("id"))));

app.post("/api/cards/:id/merge", async (c) => {
  const { into } = await c.req.json<{ into: string }>();
  return c.json(await svc(c).mergeCards(c.req.param("id"), into));
});

app.get("/api/changes", async (c) => c.json(await svc(c).recentChanges(Number(c.req.query("limit") ?? 50))));

app.post("/api/changes/:batch/undo", async (c) => {
  const { force } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  return c.json(await svc(c).undoChange(c.req.param("batch"), !!force));
});

app.get("/api/inbox", async (c) => c.json(await svc(c).inbox()));
app.get("/api/inbox/:cardId", async (c) => c.json(await svc(c).inboxDetail(c.req.param("cardId"))));
app.post("/api/inbox/:cardId/reviewed", async (c) => c.json(await svc(c).markReviewed(c.req.param("cardId"))));
app.post("/api/inbox/:cardId/revert", async (c) => c.json(await svc(c).revertAiChanges(c.req.param("cardId"))));
app.post("/api/inbox-reviewed-all", async (c) => c.json(await svc(c).markReviewed()));

app.get("/api/practice/queue", async (c) => {
  const list = (k: string) => c.req.query(k)?.split(",").filter(Boolean);
  const cards = await svc(c).all();
  return c.json(await buildQueue(c.env.DB, OWNER, cards, { tzOffset: tz(c), types: list("types"), tags: list("tags") }));
});

app.post("/api/practice/review", async (c) =>
  c.json(await recordReview(c.env.DB, OWNER, await c.req.json())),
);

app.get("/api/settings", async (c) => c.json(await getSettings(c.env.DB, OWNER)));
app.put("/api/settings", async (c) => c.json(await saveSettings(c.env.DB, OWNER, await c.req.json())));
app.get("/api/stats", async (c) => c.json(await stats(c.env.DB, OWNER, tz(c))));

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default app;
