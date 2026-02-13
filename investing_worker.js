require("dotenv").config();
const { chromium } = require("playwright");
const db = require("./db");
const OpenAI = require("openai");
const { summarizeArticlePrompt } = require("./prompts");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STORAGE = process.env.PLAYWRIGHT_STORAGE || "./storageState.json";

// Ajusta estas URLs a tus secciones reales dentro de InvestingPro
const URLS = {
  home: "https://www.investing.com/",           // placeholder
  pro: "https://www.investing.com/",            // placeholder
  latest: "https://www.investing.com/",         // placeholder: aquí pondrás la sección “latest analysis”
};

async function ensureSession(page) {
  // Si ya guardaste storageState, normalmente no necesitas loguear cada vez
  // Si InvestingPro te pide login, aquí metes el flujo.
  // Te dejo base: detecta si hay botón “Sign in” y hace login.
  const email = process.env.INVESTING_EMAIL;
  const pass = process.env.INVESTING_PASSWORD;

  if (!email || !pass) return;

  // TODO: Ajusta selectores según la página real
  // Ejemplo genérico (probablemente necesitarás modificarlo):
  // await page.click("text=Sign in");
  // await page.fill("input[type=email]", email);
  // await page.fill("input[type=password]", pass);
  // await page.click("button:has-text('Sign in')");
  // await page.waitForLoadState("networkidle");
}

function alreadySaved(url) {
  const row = db.prepare(`SELECT id FROM research_items WHERE url=?`).get(url);
  return !!row;
}

async function summarizeAndStore({ source, title, url, author, published_at, content }) {
  const prompt = summarizeArticlePrompt({ title, url, content });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });

  let parsed;
  try {
    parsed = JSON.parse(resp.choices[0].message.content);
  } catch {
    // fallback si no devuelve JSON perfecto
    parsed = {
      tldr: resp.choices[0].message.content.slice(0, 400),
      thesis: [],
      catalysts: [],
      risks: [],
      tickers: [],
      score: 50,
    };
  }

  db.prepare(`
    INSERT INTO research_items
      (source, title, url, author, published_at, tickers, summary, thesis, catalysts, risks, score, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(
    source,
    title,
    url,
    author || "",
    published_at || "",
    JSON.stringify(parsed.tickers || []),
    parsed.tldr || "",
    JSON.stringify(parsed.thesis || []),
    JSON.stringify(parsed.catalysts || []),
    JSON.stringify(parsed.risks || []),
    Number(parsed.score || 50)
  );

  console.log("✅ Guardado:", title);
}

async function runOnce() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE }).catch(() => browser.newContext());
  const page = await context.newPage();

  await page.goto(URLS.latest, { waitUntil: "domcontentloaded" });
  await ensureSession(page);

  // TODO: Ajusta selectores para capturar lista de artículos nuevos
  // Ejemplo genérico: encontrar links
  const links = await page.$$eval("a", (as) =>
    as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
      .filter((x) => x.href && x.text && x.text.length > 20)
  );

  // Aquí filtras solo “análisis” reales por URL pattern
  const candidates = links
    .filter((x) => x.href.includes("investing.com")) // ajusta patrón
    .slice(0, 10);

  for (const c of candidates) {
    if (alreadySaved(c.href)) continue;

    // abrir artículo
    const article = await context.newPage();
    await article.goto(c.href, { waitUntil: "domcontentloaded" });

    // TODO: selector del contenido del artículo
    const title = await article.title();
    const body = await article.innerText("body");

    await summarizeAndStore({
      source: "InvestingPro",
      title: c.text || title,
      url: c.href,
      author: "",
      published_at: "",
      content: body,
    });

    await article.close();
  }

  // Guarda sesión si se actualizó
  await context.storageState({ path: STORAGE });
  await browser.close();
}

if (process.argv.includes("--once")) {
  runOnce().catch((e) => {
    console.error("❌ worker error:", e.message);
    process.exit(1);
  });
} else {
  console.log("Usa: node investing_worker.js --once");
}