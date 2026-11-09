export interface Reference {
  id: string;
  label: string;
  url: string;
}

export interface Item {
  id: string;
  /** Answer text. Links are inline, wiki-style: [[slug]] or [[slug|shown text]]. */
  text: string;
  refs?: Reference[];
}

export type SectionStatus = "open" | "not_applicable";

export interface Section {
  key: string;
  prompt: string;
  origin: "template" | "custom";
  status: SectionStatus;
  items: Item[];
}

/** The editable content of a card (stored as JSON). */
export interface CardContent {
  aliases: string[];
  summary: string;
  tags: string[];
  sections: Section[];
  references: Reference[];
  notes: string;
}

export interface Card extends CardContent {
  id: string;
  slug: string;
  type: string;
  title: string;
  isStub: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ChangeSource = "app" | "ai";

export interface ChangeEntry {
  id: number;
  batchId: string;
  cardId: string;
  cardTitle: string;
  cardSlug: string;
  source: ChangeSource;
  action: string;
  summary: string;
  createdAt: string;
  reviewedAt: string | null;
  undoneAt: string | null;
}

export interface InboxEntry {
  cardId: string;
  cardSlug: string;
  cardTitle: string;
  isNew: boolean;
  isDeleted: boolean;
  summaries: string[];
  firstChangeAt: string;
  lastChangeAt: string;
}

export interface Settings {
  newPerDay: number;
  maxReviewsPerDay: number;
  practiceMode: "single";
}

export const DEFAULT_SETTINGS: Settings = {
  newPerDay: 10,
  maxReviewsPerDay: 200,
  practiceMode: "single",
};

/** FSRS scheduling state for one (card, section) pair, serialised. */
export interface SrsState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string | null;
}

export interface PracticeItem {
  cardId: string;
  sectionKey: string;
  isNew: boolean;
  srs: SrsState | null;
}

export interface PracticeQueue {
  items: PracticeItem[];
  dueCount: number;
  newCount: number;
  reviewedToday: number;
}
