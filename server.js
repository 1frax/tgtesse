require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.DASHBOARD_PORT || 8787;
const TOKEN = process.env.DASHBOARD_TOKEN || "";

// Auth simple por token (para que no cualquiera entre)
function auth(req, res, next) {
  const t = req.headers.authorization?.replace("Bearer ", "") || "";
  if (!TOKEN || t === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// --- API ---
app.get("/api/items", auth, async (req, res) => {
  try {
    const status = req.query.status || "new";
    const rows = await db.many(
      "SELECT * FROM research_items WHERE status = $1 ORDER BY created_at DESC LIMIT 200",
      [status]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/items/:id", auth, async (req, res) => {
  try {
    const row = await db.one("SELECT * FROM research_items WHERE id = $1", [req.params.id]);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/items/:id/approve", auth, async (req, res) => {
  try {
    await db.run("UPDATE research_items SET status = 'approved' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/items/:id/ignore", auth, async (req, res) => {
  try {
    await db.run("UPDATE research_items SET status = 'ignored' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/worker-runs", auth, async (_, res) => {
  try {
    const rows = await db.many(
      "SELECT * FROM worker_runs WHERE worker_name = 'investing' ORDER BY started_at DESC LIMIT 50"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jobs", auth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = status
      ? await db.many(
          "SELECT * FROM analysis_jobs WHERE status = $1 ORDER BY created_at DESC LIMIT 100",
          [status]
        )
      : await db.many("SELECT * FROM analysis_jobs ORDER BY created_at DESC LIMIT 100");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard HTML (MVP) ---
app.get("/", (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>TESSE Research Dashboard</title>
  <style>
    body { font-family: Arial; margin: 20px; }
    .row { border: 1px solid #ddd; padding: 10px; margin: 10px 0; }
    button { margin-right: 6px; }
    .meta { color: #666; font-size: 12px; }
    .title { font-weight: bold; }
  </style>
</head>
<body>
  <h2>TESSE Research Inbox</h2>
  <p class="meta">Usa Authorization Bearer token en tu navegador con una extensión, o abre en Postman. (MVP)</p>
  <p class="meta">Recomendación: abrimos después login UI. Por ahora usa API.</p>
  <hr/>
  <p>Endpoints:</p>
  <ul>
    <li>GET /api/items?status=new</li>
    <li>POST /api/items/:id/approve</li>
    <li>POST /api/items/:id/ignore</li>
  </ul>
</body>
</html>
  `);
});

async function main() {
  await db.init();
  app.listen(PORT, () => console.log(`🖥️ Dashboard en http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error("[FATAL] dashboard init:", err.message);
  process.exit(1);
});
