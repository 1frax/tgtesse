require("dotenv").config();
const { chromium } = require("playwright");
const db = require("./db");
const OpenAI = require("openai");
const { summarizeArticlePrompt } = require("./prompts");

const STORAGE = process.env.PLAYWRIGHT_STORAGE || "./storageState.json";
const MAX_ARTICLES = Number(process.env.INVESTING_MAX_ARTICLES || 8);

const URLS = {
  home: process.env.INVESTING_HOME_URL || "https://www.investing.com/",
  latest: process.env.INVESTING_LATEST_URL || "https://www.investing.com/analysis/",
};

const SELECTORS = {
  signInTrigger: process.env.INVESTING_SIGNIN_TRIGGER_SELECTOR || "a:has-text('Sign in'), a:has-text('Log in')",
  email: process.env.INVESTING_EMAIL_SELECTOR || "input[type='email']",
  password: process.env.INVESTING_PASSWORD_SELECTOR || "input[type='password']",
  submit: process.env.INVESTING_SUBMIT_SELECTOR || "button:has-text('Sign in'), button:has-text('Log in')",
  articleLinks:
    process.env.INVESTING_ARTICLE_LINKS_SELECTOR ||
    "a[href*='/analysis/'], a[data-test*='article'], a[href*='news/']",
  articleTitle: process.env.INVESTING_ARTICLE_TITLE_SELECTOR || "h1",
  articleBody: process.env.INVESTING_ARTICLE_BODY_SELECTOR || "article, main",
  articleAuthor: process.env.INVESTING_ARTICLE_AUTHOR_SELECTOR || "[class*='author'], [data-test*='author']",
  articleDate: process.env.INVESTING_ARTICLE_DATE_SELECTOR || "time",
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no configurada.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function alreadySaved(url) {
  const row = await db.one("SELECT id FROM research_items WHERE url = $1", [url]);
  return !!row;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    return u.toString();
  } catch {
    return url;
  }
}

function isInvestingUrl(url) {
  return /https?:\/\/(www\.)?investing\.com\//i.test(url);
}

async function ensureSession(page) {
  const email = process.env.INVESTING_EMAIL;
  const pass = process.env.INVESTING_PASSWORD;

  if (!email || !pass) {
    console.warn("[WARN] INVESTING_EMAIL/INVESTING_PASSWORD no configuradas. Se intentara modo publico.");
    return;
  }

  try {
    await page.goto(URLS.home, { waitUntil: "domcontentloaded", timeout: 45000 });
    const hasTrigger = await page.locator(SELECTORS.signInTrigger).first().isVisible().catch(() => false);
    if (!hasTrigger) {
      console.log("[INFO] Sesion activa detectada o login no requerido.");
      return;
    }

    await page.locator(SELECTORS.signInTrigger).first().click({ timeout: 15000 }).catch(() => {});
    await page.locator(SELECTORS.email).first().fill(email, { timeout: 15000 });
    await page.locator(SELECTORS.password).first().fill(pass, { timeout: 15000 });
    await page.locator(SELECTORS.submit).first().click({ timeout: 15000 });
    await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {});

    console.log("[OK] Login Investing ejecutado.");
  } catch (err) {
    console.warn("[WARN] Login Investing no completado:", err.message);
  }
}

async function collectCandidateLinks(page) {
  await page.goto(URLS.latest, { waitUntil: "domcontentloaded", timeout: 45000 });

  const links = await page
    .$$eval(SELECTORS.articleLinks, (as) =>
      as
        .map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
        .filter((x) => x.href && x.text && x.text.length > 20)
    )
    .catch(() => []);

  const dedup = new Map();
  for (const link of links) {
    if (!isInvestingUrl(link.href)) continue;
    const clean = link.href.split("#")[0];
    if (!dedup.has(clean)) dedup.set(clean, { href: clean, text: link.text });
  }

  return Array.from(dedup.values()).slice(0, MAX_ARTICLES);
}

async function extractArticleData(context, candidate) {
  const article = await context.newPage();
  try {
    await article.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 45000 });

    const title =
      (await article.locator(SELECTORS.articleTitle).first().innerText().catch(() => "")) ||
      (await article.title().catch(() => "")) ||
      candidate.text;

    const body =
      (await article.locator(SELECTORS.articleBody).first().innerText().catch(() => "")) ||
      (await article.innerText("body").catch(() => ""));

    const author = await article.locator(SELECTORS.articleAuthor).first().innerText().catch(() => "");

    const publishedAtAttr = await article.locator(SELECTORS.articleDate).first().getAttribute("datetime").catch(() => "");
    const publishedAtText = await article.locator(SELECTORS.articleDate).first().innerText().catch(() => "");

    return {
      title: title.trim(),
      body: body.trim(),
      author: author.trim(),
      published_at: (publishedAtAttr || publishedAtText || "").trim(),
    };
  } finally {
    await article.close();
  }
}

async function summarizeAndStore({ source, title, url, author, published_at, content }) {
  const openai = getOpenAIClient();
  const prompt = summarizeArticlePrompt({ title, url, content });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });

  let parsed;
  try {
    parsed = JSON.parse(resp.choices[0].message.content || "{}");
  } catch {
    parsed = {
      tldr: (resp.choices[0].message.content || "").slice(0, 400),
      thesis: [],
      catalysts: [],
      risks: [],
      tickers: [],
      score: 50,
    };
  }

  const result = await db.run(
    `
      INSERT INTO research_items
        (source, title, url, author, published_at, tickers, summary, thesis, catalysts, risks, score, status)
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, 'new')
      ON CONFLICT (url) DO NOTHING
    `,
    [
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
      Number(parsed.score || 50),
    ]
  );

  if (result.rowCount > 0) {
    console.log("[OK] Guardado:", title);
    return true;
  }

  return false;
}

async function runOnce() {
  console.log("[INFO] Iniciando investing worker...");
  await db.init();

  const startedRun = await db.one(
    `
      INSERT INTO worker_runs (worker_name, status)
      VALUES ('investing', 'running')
      RETURNING id
    `
  );
  const runId = startedRun?.id;

  let processedCount = 0;
  let insertedCount = 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE }).catch(() => browser.newContext());
  const page = await context.newPage();

  try {
    await ensureSession(page);
    const candidates = await collectCandidateLinks(page);

    if (!candidates.length) {
      console.warn("[WARN] No se encontraron articulos candidatos. Ajusta URL/selectores de Investing.");
    }

    for (const c of candidates) {
      const cleanUrl = normalizeUrl(c.href);
      if (await alreadySaved(cleanUrl)) continue;

      processedCount += 1;
      const articleData = await extractArticleData(context, { ...c, href: cleanUrl });
      if (!articleData.body || articleData.body.length < 200) {
        console.warn("[WARN] Contenido corto o vacio, se omite:", cleanUrl);
        continue;
      }

      const inserted = await summarizeAndStore({
        source: "InvestingPro",
        title: articleData.title || c.text,
        url: cleanUrl,
        author: articleData.author,
        published_at: articleData.published_at,
        content: articleData.body,
      });

      if (inserted) insertedCount += 1;
    }

    if (runId) {
      await db.run(
        `
          UPDATE worker_runs
          SET status = 'success',
              finished_at = NOW(),
              processed_count = $1,
              inserted_count = $2
          WHERE id = $3
        `,
        [processedCount, insertedCount, runId]
      );
    }

    await context.storageState({ path: STORAGE });
  } catch (err) {
    if (runId) {
      await db.run(
        `
          UPDATE worker_runs
          SET status = 'failed',
              finished_at = NOW(),
              processed_count = $1,
              inserted_count = $2,
              error = $3
          WHERE id = $4
        `,
        [processedCount, insertedCount, String(err.message || err), runId]
      );
    }
    throw err;
  } finally {
    await browser.close();
    await db.close();
  }
}

function printDoctor() {
  const checks = [
    ["DATABASE_URL", !!process.env.DATABASE_URL],
    ["OPENAI_API_KEY", !!process.env.OPENAI_API_KEY],
    ["INVESTING_EMAIL", !!process.env.INVESTING_EMAIL],
    ["INVESTING_PASSWORD", !!process.env.INVESTING_PASSWORD],
    ["INVESTING_LATEST_URL", !!process.env.INVESTING_LATEST_URL],
    ["PLAYWRIGHT_STORAGE", !!process.env.PLAYWRIGHT_STORAGE],
  ];

  console.log("[INFO] Config doctor:");
  for (const [key, ok] of checks) {
    console.log(`- ${key}: ${ok ? "OK" : "MISSING"}`);
  }
}

if (process.argv.includes("--doctor")) {
  printDoctor();
} else if (process.argv.includes("--once")) {
  runOnce().catch((e) => {
    console.error("[ERROR] worker:", e.message);
    process.exit(1);
  });
} else {
  console.log("Usa: node investing_worker.js --once");
  console.log("O usa: node investing_worker.js --doctor");
}
