// Minimal stateless MCP server (Streamable HTTP transport, JSON responses).
// Implements what tool-using clients need: initialize, ping, tools/list, tools/call.

import { CardService, UserError } from "../core/service";
import guidance from "./guidance.md";
import { jsonSchemaOf, TOOL_BY_NAME, TOOLS } from "./tools";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Reply = { jsonrpc: "2.0"; id: string | number | null } & (
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
);

export async function handleMcp(request: Request, db: D1Database, ownerId: string): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const replies: Reply[] = [];
  for (const msg of messages) {
    const reply = await handleMessage(msg, db, ownerId);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}

async function handleMessage(msg: JsonRpcRequest, db: D1Database, ownerId: string): Promise<Reply | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const id = msg.id ?? null;
  const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "improv-flashcards", title: "Improv Flashcards", version: "1.0.0" },
        instructions: guidance,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: jsonSchemaOf(t),
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: t.name === "delete_card" },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return fail(-32602, `Unknown tool: ${name}`);
      const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) return ok(toolError(`Invalid arguments: ${parsed.error.message}`));
      try {
        const result = await tool.run(new CardService(db, ownerId, "ai"), parsed.data);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        if (e instanceof UserError) return ok(toolError(e.message));
        console.error(e);
        return ok(toolError("Internal error: " + (e as Error).message));
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
