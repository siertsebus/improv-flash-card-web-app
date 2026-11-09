-- Every table carries owner_id so the app can become multi-user later. Phase 1 uses 'me'.

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  is_stub INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,          -- JSON CardContent
  search_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cards_owner_slug ON cards (owner_id, slug);

CREATE TABLE links (
  owner_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  PRIMARY KEY (from_id, to_slug)
);
CREATE INDEX links_to ON links (owner_id, to_slug);

-- One row per changed card. Rows sharing batch_id belong to one logical change (e.g. a rename
-- that rewrites links in other cards) and are undone together.
CREATE TABLE revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'app' | 'ai'
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  before TEXT,                    -- JSON Card snapshot, NULL when created
  after TEXT,                     -- JSON Card snapshot, NULL when deleted
  created_at TEXT NOT NULL,
  reviewed_at TEXT,               -- AI changes start unreviewed
  undone_at TEXT
);
CREATE INDEX revisions_owner_created ON revisions (owner_id, created_at);
CREATE INDEX revisions_card ON revisions (card_id);
CREATE INDEX revisions_batch ON revisions (batch_id);
CREATE INDEX revisions_unreviewed ON revisions (owner_id, source, reviewed_at);

CREATE TABLE srs (
  owner_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  due TEXT NOT NULL,
  state TEXT NOT NULL,            -- JSON SrsState
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (card_id, section_key)
);
CREATE INDEX srs_owner_due ON srs (owner_id, due);

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  rating INTEGER NOT NULL,
  was_new INTEGER NOT NULL,
  mode TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX review_log_owner_time ON review_log (owner_id, reviewed_at);

CREATE TABLE settings (
  owner_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
