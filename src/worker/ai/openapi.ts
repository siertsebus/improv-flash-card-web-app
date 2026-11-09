// OpenAPI description of the tool endpoints, for AI services that use REST "actions"
// instead of MCP (e.g. custom GPTs). Auth: `Authorization: Bearer <API_TOKEN>`.

import guidance from "./guidance.md";
import { jsonSchemaOf, TOOLS } from "./tools";

export function openApiSpec(origin: string) {
  const paths: Record<string, unknown> = {};
  for (const t of TOOLS) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.slice(0, 300),
        requestBody: { required: true, content: { "application/json": { schema: jsonSchemaOf(t) } } },
        responses: {
          "200": { description: "Result", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "Invalid request or user error (message in `error`)" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Improv Flashcards", version: "1.0.0", description: guidance },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths,
  };
}
