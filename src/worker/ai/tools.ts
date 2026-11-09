// AI tool definitions. Vendor-neutral: each tool is a name, a description, a zod input schema
// and a handler on the core service. The MCP server and the REST tool endpoints (+ OpenAPI)
// are both generated from this list.

import { z } from "zod";
import { CARD_TYPE_KEYS } from "../../shared/templates";
import type { CardService } from "../core/service";

const cardRef = z.string().describe("Card slug, title or alias");
const itemInput = z.union([
  z.string(),
  z.object({
    text: z.string(),
    refs: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  }),
]);
const answers = z.array(itemInput).describe('Short answers. Inline links: "[[Title]]" or "[[slug|shown text]]".');

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  readOnly?: boolean;
  run: (svc: CardService, args: z.infer<S>) => Promise<unknown>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export const TOOLS: ToolDef[] = [
  tool({
    name: "get_card_types",
    description: "List the card types and their template questions (question keys and prompts).",
    input: z.object({}),
    readOnly: true,
    run: async (svc) => svc.getCardTypes(),
  }),
  tool({
    name: "search_cards",
    description:
      "Search cards by title, alias, tag or answer text. Use before creating a card. An empty query lists all cards.",
    input: z.object({
      query: z.string(),
      type: z.enum(CARD_TYPE_KEYS).optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    readOnly: true,
    run: async (svc, a) => svc.search(a.query, { type: a.type, tag: a.tag }, a.limit ?? 15),
  }),
  tool({
    name: "get_card",
    description: "Get a full card: questions with answers (incl. answer ids), references, notes, links and backlinks.",
    input: z.object({ card: cardRef }),
    readOnly: true,
    run: async (svc, a) => svc.describeCard(a.card),
  }),
  tool({
    name: "create_card",
    description:
      "Create a new card from its type's template, or fill in an existing stub with that title. " +
      "`answers` maps template question keys to answer lists.",
    input: z.object({
      type: z.enum(CARD_TYPE_KEYS),
      title: z.string(),
      answers: z.record(z.string(), answers).optional(),
      notApplicable: z.array(z.string()).optional().describe("Template question keys that don't apply to this card"),
      customQuestions: z
        .array(z.object({ prompt: z.string(), answers: answers.optional() }))
        .optional()
        .describe("Only when the user explicitly asked for extra questions"),
      aliases: z.array(z.string()).optional(),
      summary: z.string().optional().describe("Optional one-line description"),
      tags: z.array(z.string()).optional(),
      references: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
      notes: z.string().optional(),
    }),
    run: async (svc, a) => svc.createCard(a),
  }),
  tool({
    name: "add_answers",
    description: "Append answers to one question of a card. Near-duplicates are skipped.",
    input: z.object({ card: cardRef, question: z.string().describe("Question key or prompt"), answers }),
    run: async (svc, a) => svc.addItems(a.card, a.question, a.answers),
  }),
  tool({
    name: "update_answer",
    description: "Replace the text of one answer (answer ids come from get_card).",
    input: z.object({ card: cardRef, answerId: z.string(), text: z.string() }),
    run: async (svc, a) => svc.updateItem(a.card, a.answerId, a.text),
  }),
  tool({
    name: "remove_answer",
    description: "Remove one answer from a card.",
    input: z.object({ card: cardRef, answerId: z.string() }),
    run: async (svc, a) => svc.removeItem(a.card, a.answerId),
  }),
  tool({
    name: "move_answer",
    description: "Move an answer to another question of the same card and/or another position (0 = first).",
    input: z.object({
      card: cardRef,
      answerId: z.string(),
      toQuestion: z.string().optional(),
      position: z.number().int().min(0).optional(),
    }),
    run: async (svc, a) => svc.moveItem(a.card, a.answerId, a.toQuestion, a.position),
  }),
  tool({
    name: "add_reference",
    description:
      "Attach a reference link (video, article, image) to a card, or to a single answer. Shown after the answer is revealed; never quizzed.",
    input: z.object({ card: cardRef, url: z.string(), label: z.string(), answerId: z.string().optional() }),
    run: async (svc, a) => svc.addReference(a.card, { url: a.url, label: a.label }, a.answerId),
  }),
  tool({
    name: "remove_reference",
    description: "Remove a reference link by id.",
    input: z.object({ card: cardRef, referenceId: z.string() }),
    run: async (svc, a) => svc.removeReference(a.card, a.referenceId),
  }),
  tool({
    name: "add_custom_question",
    description:
      "Add an extra question to ONE card, outside its template. Only use when the user explicitly asks for a new question.",
    input: z.object({ card: cardRef, prompt: z.string(), answers: answers.optional() }),
    run: async (svc, a) => svc.addCustomQuestion(a.card, a.prompt, a.answers ?? []),
  }),
  tool({
    name: "remove_custom_question",
    description: "Remove a custom question (and its answers) from a card. Template questions can't be removed.",
    input: z.object({ card: cardRef, question: z.string() }),
    run: async (svc, a) => svc.removeCustomQuestion(a.card, a.question),
  }),
  tool({
    name: "set_question_status",
    description:
      "Mark a question 'not_applicable' for this card (skipped in practice), or 'open' again.",
    input: z.object({ card: cardRef, question: z.string(), status: z.enum(["open", "not_applicable"]) }),
    run: async (svc, a) => svc.setSectionStatus(a.card, a.question, a.status),
  }),
  tool({
    name: "update_card_details",
    description: "Set aliases, summary, tags or notes of a card. Given lists replace the existing ones.",
    input: z.object({
      card: cardRef,
      aliases: z.array(z.string()).optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    run: async (svc, a) => svc.updateCardFields(a.card, a),
  }),
  tool({
    name: "rename_card",
    description: "Rename a card. Links from other cards are updated automatically.",
    input: z.object({ card: cardRef, title: z.string() }),
    run: async (svc, a) => svc.renameCard(a.card, a.title),
  }),
  tool({
    name: "change_card_type",
    description: "Change a card's type. Answers under questions the new type lacks are kept as custom questions.",
    input: z.object({ card: cardRef, type: z.enum(CARD_TYPE_KEYS) }),
    run: async (svc, a) => svc.changeType(a.card, a.type),
  }),
  tool({
    name: "merge_cards",
    description: "Merge `source` into `target` (answers, aliases, references, notes); links are redirected, source is removed.",
    input: z.object({ source: cardRef, target: cardRef }),
    run: async (svc, a) => svc.mergeCards(a.source, a.target),
  }),
  tool({
    name: "delete_card",
    description: "Delete a card. Links to it in other cards become plain text. Only when the user asks.",
    input: z.object({ card: cardRef }),
    run: async (svc, a) => svc.deleteCard(a.card),
  }),
  tool({
    name: "list_stubs",
    description: "Cards that are linked to but not written yet.",
    input: z.object({}),
    readOnly: true,
    run: async (svc) => svc.listStubs(),
  }),
  tool({
    name: "list_unfilled",
    description: "Cards with template questions that have no answers yet.",
    input: z.object({}),
    readOnly: true,
    run: async (svc) => svc.listUnfilled(),
  }),
  tool({
    name: "recent_changes",
    description: "Recent changes to cards (by the app or AI), newest first. `changeId` is used by undo_change.",
    input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    readOnly: true,
    run: async (svc, a) =>
      (await svc.recentChanges(a.limit ?? 20)).map((c) => ({
        changeId: c.batchId,
        card: c.cardTitle,
        source: c.source,
        summary: c.summary,
        at: c.createdAt,
        undone: !!c.undoneAt,
      })),
  }),
  tool({
    name: "undo_change",
    description: "Undo a change by its changeId. Set force=true if later edits on the same card may be reverted too.",
    input: z.object({ changeId: z.string(), force: z.boolean().optional() }),
    run: async (svc, a) => svc.undoChange(a.changeId, a.force ?? false),
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function jsonSchemaOf(t: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
