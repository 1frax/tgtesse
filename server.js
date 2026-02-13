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
app.get("/api/items", auth, (req, res) => {
  const status = req.query.status || "new";
  const rows = db
    .prepare(`SELECT * FROM research_items WHERE status=? ORDER BY created_at DESC LIMIT 200`)
    .all(status);
  res.json(rows);
});

app.get("/api/items/:id", auth, (req, res) => {
  const row = db.prepare(`SELECT * FROM research_items WHERE id=?`).get(req.params.id);
  res.json(row || null);
});

app.post("/api/items/:id/approve", auth, (req, res) => {
  db.prepare(`UPDATE research_items SET status='approved' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/items/:id/ignore", auth, (req, res) => {
  db.prepare(`UPDATE research_items SET status='ignored' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
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

app.listen(PORT, () => console.log(`🖥️ Dashboard en http://localhost:${PORT}`));