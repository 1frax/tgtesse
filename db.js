const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Railway: monta un Volume en /data y guarda la DB ahí.
// Local: si no hay DB_PATH, usa el archivo del proyecto.
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "tesse.db");

// Asegura que exista el folder donde vive la DB
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS subscribers (
  chat_id TEXT PRIMARY KEY,
  is_active INTEGER DEFAULT 1,
  tz TEXT DEFAULT 'America/Mexico_City',
  quiet_start INTEGER DEFAULT 23,
  quiet_end INTEGER DEFAULT 8,
  markets TEXT DEFAULT '["indices","fx","crypto"]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS research_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  author TEXT,
  published_at TEXT,
  tickers TEXT,
  summary TEXT,
  thesis TEXT,
  catalysts TEXT,
  risks TEXT,
  score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_status ON research_items(status);
CREATE INDEX IF NOT EXISTS idx_research_created ON research_items(created_at);
`);

module.exports = db;