// Card type templates. These are the *default* questions for each type (see card-types.md).
// Cards can carry extra custom sections; a card never stops being its type because of that.
// Changing a template here is a deliberate change: existing cards pick it up automatically
// (missing template sections appear empty; content under removed questions becomes custom).

export type CardTypeKey =
  | "archetype"
  | "role"
  | "situation"
  | "genre"
  | "popculture"
  | "voice"
  | "location";

export interface TemplateQuestion {
  key: string;
  prompt: string;
  /** Kind of card the answers usually link to. Only a hint for suggestions; any link is allowed. */
  linkHint?: CardTypeKey;
}

export interface CardTemplate {
  key: CardTypeKey;
  label: string;
  description: string;
  examples: string[];
  questions: TemplateQuestion[];
}

export const TEMPLATES: CardTemplate[] = [
  {
    key: "archetype",
    label: "Character archetype",
    description: "A recognisable kind of person or character.",
    examples: ["Doctor", "Batman", "Lawyer", "High-school jock", "Climate activist"],
    questions: [
      { key: "cares", prompt: "What do they care about?" },
      { key: "physicality", prompt: "What mannerisms, movements or posture do they have?" },
      { key: "voice", prompt: "What does their voice sound like?", linkHint: "voice" },
      { key: "phrases", prompt: "What phrases or lines do they use?" },
      {
        key: "items",
        prompt: "What recognisable items do they have?",
      },
    ],
  },
  {
    key: "role",
    label: "Character role",
    description: "A narrative role or arc a character can play, independent of who they are.",
    examples: ["Career-obsessed", "Longing for adventure", "Irredeemable villain", "Stern mentor"],
    questions: [
      { key: "cares", prompt: "What do they care about?" },
      { key: "start", prompt: "How do they start out?" },
      { key: "fate", prompt: "What will happen to them?" },
      { key: "change", prompt: "How does their personality change?" },
    ],
  },
  {
    key: "situation",
    label: "Situation",
    description: "A type of event or situation a scene can be about.",
    examples: ["Wedding", "Car race", "First date"],
    questions: [
      { key: "happens", prompt: "What typically happens?" },
      { key: "where", prompt: "Where do these situations occur?", linkHint: "location" },
      { key: "people", prompt: "What types of people are present?", linkHint: "archetype" },
    ],
  },
  {
    key: "genre",
    label: "Genre",
    description: "A genre or style of story.",
    examples: ["Dystopian philosophical sci-fi", "Steampunk", "Spaghetti western", "Zombie apocalypse"],
    questions: [
      {
        key: "characters",
        prompt: "What character archetypes and character roles do we expect?",
        linkHint: "archetype",
      },
      { key: "situations", prompt: "What situations do we expect?", linkHint: "situation" },
      { key: "locations", prompt: "What locations do we expect?", linkHint: "location" },
    ],
  },
  {
    key: "popculture",
    label: "Pop culture / General",
    description: "Catch-all: franchises, subcultures, phenomena, anything else.",
    examples: ["Harry Potter series", "Alien conspiracy theories", "BuzzFeed", "Gaming culture"],
    questions: [{ key: "expect", prompt: "What do we expect?" }],
  },
  {
    key: "voice",
    label: "Voice",
    description: "An accent, dialect or way of speaking. Attach reference videos as references.",
    examples: ["Irish accent", "Pirate voice", "Posh British", "Sports commentator"],
    questions: [{ key: "phrases", prompt: "Replacements and phrases" }],
  },
  {
    key: "location",
    label: "Location",
    description: "A place where scenes happen.",
    examples: ["Church", "Hospital", "Saloon", "Spaceship bridge"],
    questions: [
      { key: "happens", prompt: "What normally happens here?" },
      { key: "people", prompt: "What types of people are normally present?", linkHint: "archetype" },
      { key: "situations", prompt: "What situations normally happen here?", linkHint: "situation" },
    ],
  },
];

export const TEMPLATE_BY_KEY: Record<string, CardTemplate> = Object.fromEntries(
  TEMPLATES.map((t) => [t.key, t]),
);

export const CARD_TYPE_KEYS = TEMPLATES.map((t) => t.key) as [CardTypeKey, ...CardTypeKey[]];

/** Type used for stubs when nothing better is known. */
export const DEFAULT_STUB_TYPE: CardTypeKey = "popculture";

export function typeLabel(type: string): string {
  return TEMPLATE_BY_KEY[type]?.label ?? type;
}
