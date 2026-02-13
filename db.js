require("dotenv").config();
const { Pool } = require("pg");

let pool = null;

let initialized = false;

function getPool() {
  if (pool) return pool;

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL no configurada. Agrega un servicio Postgres en Railway y comparte la variable al bot/worker.");
  }

  const forceSSL = process.env.PGSSL === "true" || /sslmode=require/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ...(forceSSL ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function one(text, params = []) {
  const result = await getPool().query(text, params);
  return result.rows[0] || null;
}

async function many(text, params = []) {
  const result = await getPool().query(text, params);
  return result.rows;
}

async function run(text, params = []) {
  const result = await getPool().query(text, params);
  return {
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

async function init() {
  if (initialized) return;

  await query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id TEXT PRIMARY KEY,
      is_active BOOLEAN DEFAULT TRUE,
      tz TEXT DEFAULT 'America/Mexico_City',
      quiet_start INTEGER DEFAULT 23,
      quiet_end INTEGER DEFAULT 8,
      markets JSONB DEFAULT '["indices","fx","crypto"]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS research_items (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      author TEXT,
      published_at TEXT,
      tickers JSONB DEFAULT '[]'::jsonb,
      summary TEXT,
      thesis JSONB DEFAULT '[]'::jsonb,
      catalysts JSONB DEFAULT '[]'::jsonb,
      risks JSONB DEFAULT '[]'::jsonb,
      score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_research_status ON research_items(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_research_created ON research_items(created_at DESC);`);

  await query(`
    CREATE TABLE IF NOT EXISTS worker_runs (
      id BIGSERIAL PRIMARY KEY,
      worker_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      processed_count INTEGER DEFAULT 0,
      inserted_count INTEGER DEFAULT 0,
      error TEXT
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_worker_runs_worker ON worker_runs(worker_name, started_at DESC);`);

  initialized = true;
  console.log("[OK] Postgres schema listo.");
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  pool: () => pool,
  query,
  one,
  many,
  run,
  init,
  close,
};
